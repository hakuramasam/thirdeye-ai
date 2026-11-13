/**
 * SSRF guard for outbound agent traffic (MCP servers and http_fetch).
 *
 * Threat model: a user-supplied URL (an MCP server URL, or a URL an agent was told to
 * fetch) pointed at cloud metadata, loopback, private RFC1918 space, or an internal
 * service. Second threat: DNS rebinding, where the hostname resolves to a public address
 * during the check and to a private one at connect time.
 *
 * Mitigations, in order of strength:
 *  1. Static validation: scheme, credentials, port, length, literal-IP checks.
 *  2. Resolution check: every A/AAAA record must be a public unicast address.
 *  3. Connection pinning (guardedFetch only): the socket connects to the exact address we
 *     validated, through the `lookup` hook, so a second DNS answer cannot redirect it.
 *     TLS still validates against the hostname via servername.
 *  4. Redirects are re-validated hop by hop, and never allowed to leave an allowlisted host.
 *
 * Residual risk, stated plainly: an MCP transport owns its own HTTP client, so there we do
 * the resolution check before connecting and again before each tool call instead of pinning
 * the socket. That closes the practical rebinding window; it is not a substitute for
 * network-level egress control.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

export class SsrfError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SsrfError'
    this.code = code
  }
}

export type SsrfPolicy = {
  /** Hosts explicitly allowed to be internal (e.g. a self-hosted MCP server). Empty by default. */
  allowHosts?: string[]
  maxRedirects?: number
  timeoutMs?: number
  maxBytes?: number
  /** Ports below 1024 refused unless the host is allowlisted. 80 and 443 always pass. */
  allowLowPorts?: number[]
}

const DEFAULT_POLICY: Required<SsrfPolicy> = {
  allowHosts: [],
  maxRedirects: 3,
  timeoutMs: 15000,
  maxBytes: 2 * 1024 * 1024,
  allowLowPorts: [80, 443],
}

const MAX_URL_LENGTH = 2048

/** IPv4 ranges that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function v4ToInt(ip: string): number {
  const parts = ip.split('.')
  if (parts.length !== 4) return -1
  let n = 0
  for (const p of parts) {
    const b = Number(p)
    if (!Number.isInteger(b) || b < 0 || b > 255) return -1
    n = (n << 8) | b
  }
  return n >>> 0
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const a = v4ToInt(ip)
  const b = v4ToInt(base)
  if (a < 0 || b < 0) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1) & 0xffffffff) >>> 0
  return (a & mask) === (b & mask)
}

function expandV6(ip: string): number[] | null {
  const addr = ip.split('%')[0]
  if (!addr.includes(':')) return null
  const [head, tail] = addr.split('::')
  const headGroups = head ? head.split(':').filter((s) => s.length > 0) : []
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':').filter((s) => s.length > 0) : []
  const parseGroup = (g: string): number[] | null => {
    if (g.includes('.')) {
      const v4 = v4ToInt(g)
      if (v4 < 0) return null
      return [Math.floor(v4 / 65536), v4 % 65536]
    }
    const n = Number.parseInt(g, 16)
    return Number.isNaN(n) ? null : [n]
  }
  const headNums: number[] = []
  for (const g of headGroups) {
    const n = parseGroup(g)
    if (!n) return null
    headNums.push(...n)
  }
  const tailNums: number[] = []
  for (const g of tailGroups) {
    const n = parseGroup(g)
    if (!n) return null
    tailNums.push(...n)
  }
  if (addr.includes('::')) {
    const fill = 8 - (headNums.length + tailNums.length)
    if (fill < 0) return null
    return [...headNums, ...new Array(fill).fill(0), ...tailNums]
  }
  return headNums.length === 8 ? headNums : null
}

function inV6Prefix(groups: number[], prefixGroups: number[], bits: number): boolean {
  const fullGroups = Math.floor(bits / 16)
  for (let i = 0; i < fullGroups; i++) {
    if (groups[i] !== prefixGroups[i]) return false
  }
  const remainder = bits % 16
  if (remainder === 0) return true
  const shift = 16 - remainder
  return (groups[fullGroups] >> shift) === (prefixGroups[fullGroups] >> shift)
}

/** True when the address is public unicast, i.e. safe to dial from an untrusted URL. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    if (v4ToInt(ip) < 0) return false
    return !BLOCKED_V4.some(([base, bits]) => inV4Cidr(ip, base, bits))
  }
  if (family === 6) {
    const groups = expandV6(ip)
    if (!groups) return false
    const mapped =
      groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
    if (mapped) {
      const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
      return isPublicAddress(v4)
    }
    if (groups.every((g) => g === 0)) return false
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false
    const blocked: Array<[number[], number]> = [
      [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7],
      [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10],
      [[0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32],
      [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8],
      [[0x0100, 0, 0, 0, 0, 0, 0, 0], 64],
    ]
    return !blocked.some(([prefix, bits]) => inV6Prefix(groups, prefix, bits))
  }
  return false
}

export type ValidatedUrl = { url: URL; addresses: string[] }

/**
 * Validate a URL and every address its hostname resolves to. Throws SsrfError on refusal.
 * Every resolved address is checked, not just the first, because the client may pick any.
 */
export async function assertPublicUrl(raw: string, policy: SsrfPolicy = {}): Promise<ValidatedUrl> {
  const p = { ...DEFAULT_POLICY, ...policy }
  if (typeof raw !== 'string' || raw.trim() === '') throw new SsrfError('invalid_url', 'URL is required')
  if (raw.length > MAX_URL_LENGTH) throw new SsrfError('invalid_url', `URL longer than ${MAX_URL_LENGTH} characters`)

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError('invalid_url', 'Not a valid absolute URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('blocked_scheme', `Scheme ${url.protocol} is not allowed (http or https only)`)
  }
  if (url.username || url.password) {
    throw new SsrfError('blocked_credentials', 'Credentials in the URL are not allowed')
  }
  if (!url.hostname) throw new SsrfError('invalid_url', 'URL has no hostname')
  if (raw.startsWith('//')) throw new SsrfError('invalid_url', 'Protocol-relative URLs are not allowed')

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const allow = new Set(p.allowHosts.map((h) => h.toLowerCase()))
  const isAllowedHost = allow.has(host)

  if (!isAllowedHost) {
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      host.endsWith('.local')
    ) {
      throw new SsrfError('blocked_host', `Host ${host} is not allowed`)
    }
    if (url.port) {
      const port = Number(url.port)
      if (port > 0 && port < 1024 && !p.allowLowPorts.includes(port)) {
        throw new SsrfError('blocked_port', `Port ${port} is not allowed`)
      }
    }
  }

  if (isIP(host)) {
    if (!isAllowedHost && !isPublicAddress(host)) {
      throw new SsrfError('blocked_address', `Address ${host} is not publicly routable`)
    }
    return { url, addresses: [host] }
  }

  let records: Array<{ address: string; family: number }>
  try {
    records = await dnsLookup(host, { all: true })
  } catch (e: any) {
    throw new SsrfError('dns_failure', `Could not resolve ${host}: ${String(e?.code || e?.message || e)}`)
  }
  if (!records.length) throw new SsrfError('dns_failure', `${host} resolved to no addresses`)

  if (!isAllowedHost) {
    for (const r of records) {
      if (!isPublicAddress(r.address)) {
        throw new SsrfError('blocked_address', `${host} resolves to non-public address ${r.address}`)
      }
    }
  }
  return { url, addresses: records.map((r) => r.address) }
}

export type GuardedResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  truncated: boolean
  finalUrl: string
  redirects: string[]
}

type RawResponse = { status: number; headers: Record<string, any>; body: Buffer; truncated: boolean }

/** One hop, with the socket pinned to a pre-validated address. */
function requestPinned(
  url: URL,
  address: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  p: Required<SsrfPolicy>
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const doRequest = isHttps ? httpsRequest : httpRequest
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const req = doRequest(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: { host: url.host, ...(init.headers ?? {}) },
        servername: isHttps ? hostname : undefined,
        // The pinned lookup is the rebinding defence: it is the only way this socket may
        // resolve, and it returns the address that already passed validation.
        lookup: ((_h: string, options: any, cb: any) => {
          if (typeof options === 'function') return (options as any)(null, address, isIP(address))
          return cb(null, address, isIP(address))
        }) as any,
        timeout: p.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > p.maxBytes) {
            truncated = true
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated })
        )
        res.on('error', (e) =>
          truncated
            ? resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated })
            : reject(e)
        )
      }
    )
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${p.timeoutMs}ms`)))
    req.on('error', reject)
    if (init.body) req.write(init.body)
    req.end()
  })
}

/**
 * Fetch a user-influenced URL with every guard applied, including redirect re-validation.
 * Returns text, never a stream handle, so a caller cannot read unbounded data by accident.
 */
export async function guardedFetch(
  raw: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  policy: SsrfPolicy = {}
): Promise<GuardedResponse> {
  const p = { ...DEFAULT_POLICY, ...policy }
  const method = (init.method || 'GET').toUpperCase()
  const allow = new Set(p.allowHosts.map((h) => h.toLowerCase()))
  const redirects: string[] = []
  let current = raw
  let originalAllowedHost: string | null = null

  for (let hop = 0; hop <= p.maxRedirects; hop++) {
    const { url, addresses } = await assertPublicUrl(current, policy)
    if (hop === 0) {
      originalAllowedHost = allow.has(url.hostname.toLowerCase()) ? url.hostname.toLowerCase() : null
    } else if (originalAllowedHost && !allow.has(url.hostname.toLowerCase())) {
      throw new SsrfError('blocked_redirect', 'Redirect left the allowlisted host')
    }

    const res = await requestPinned(
      url,
      addresses[0],
      { method, headers: init.headers, body: hop === 0 ? init.body : undefined },
      p
    )

    const location = res.headers.location as string | undefined
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status)
    if (isRedirect && location) {
      if (hop === p.maxRedirects) throw new SsrfError('too_many_redirects', `More than ${p.maxRedirects} redirects`)
      if (location.startsWith('//')) throw new SsrfError('blocked_redirect', 'Protocol-relative redirect is not allowed')
      const next = new URL(location, url).toString()
      redirects.push(next)
      current = next
      continue
    }

    return {
      status: res.status,
      headers: res.headers,
      body: res.body.toString('utf8'),
      truncated: res.truncated,
      finalUrl: url.toString(),
      redirects,
    }
  }
  throw new SsrfError('too_many_redirects', 'Redirect limit reached')
}
