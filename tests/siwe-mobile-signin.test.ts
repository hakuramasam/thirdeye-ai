// Mobile sign-in: a message we generated must never be refused because the transport altered it.
//
// The failure this file pins down: "Signature does not match this site or message format." on a
// phone, for a message the site itself had just built. Two causes, both covered here — a message
// the strict EIP-4361 parser could not read (CRLF endings, a browser that re-serialises the text),
// and a domain in the message that did not match the host the request arrived on (a proxy browser
// or a wallet in-app browser presenting a different location than the request it just made).
process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL
process.env.NODE_ENV = 'production'

import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const { migrate, query } = await import('../src/db/index.js')
const { env } = await import('../src/lib/env.js')
const { registerAuthRoutes } = await import('../src/routes/auth.js')
import type { AppEnv } from '../src/lib/types.js'
const { normalizeSiweText, extractSiweDomain, normalizeHost, allowedSiweHosts, decideSiwe } = await import(
  '../src/lib/security.js'
)

const HOST = 'thirdeye-ai-alpha.vercel.app'
const account = privateKeyToAccount(generatePrivateKey())

function buildSiwe(opts: {
  domain?: string
  nonce: string
  address?: string
  eol?: string
  /** Drop the fields a strict parser requires, to force the tolerant path. */
  minimal?: boolean
}): string {
  const lines = [
    `${opts.domain ?? HOST} wants you to sign in with your Ethereum account:`,
    opts.address ?? account.address,
    '',
    'Sign in to Thirdeye AI',
    '',
  ]
  if (!opts.minimal) {
    lines.push('URI: https://' + (opts.domain ?? HOST), 'Version: 1', 'Chain ID: 8453')
  }
  lines.push(`Nonce: ${opts.nonce}`, `Issued At: ${new Date().toISOString()}`)
  return lines.join(opts.eol ?? '\n')
}

function makeApp() {
  const app = new Hono<AppEnv>()
  registerAuthRoutes(app)
  return app
}

async function issueNonce(app: Hono<AppEnv>, ip: string): Promise<{ nonce: string; domain: string | null }> {
  const res = await app.request('/api/auth/nonce', { headers: { host: HOST, 'x-forwarded-for': ip } })
  assert.equal(res.status, 200)
  return (await res.json()) as { nonce: string; domain: string | null }
}

async function verify(app: Hono<AppEnv>, ip: string, message: string, signature: string) {
  const res = await app.request('/api/auth/verify', {
    method: 'POST',
    headers: { host: HOST, 'x-forwarded-for': ip, 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

async function lastDiagnostic(): Promise<any> {
  const rows = await query('SELECT outcome, reason, message_domain, request_host, lenient FROM auth_signin_log ORDER BY id DESC LIMIT 1')
  return rows.rows?.[0] ?? (rows as any)[0]
}

before(async () => {
  await migrate()
})

/* ---------------- the pure rules ---------------- */

test('the normaliser fixes transport noise and leaves the words alone', () => {
  const raw = '\uFEFFthirdeye-ai-alpha.vercel.app wants you to sign in\r\n0xABC\r\n\r\n  \u200BSign in   \r\n'
  const out = normalizeSiweText(raw)
  assert.ok(!out.includes('\r'))
  assert.ok(!out.includes('\uFEFF'))
  assert.ok(!out.includes('\u200B'))
  assert.ok(!/\s$/.test(out), 'trailing whitespace should be gone')
  assert.ok(out.startsWith('thirdeye-ai-alpha.vercel.app wants you to sign in'))
  assert.ok(out.includes('Sign in'), 'inner text is preserved')
})

test('the domain is recovered from the first line, and only from a real SIWE first line', () => {
  assert.equal(extractSiweDomain(buildSiwe({ nonce: 'abc' })), HOST)
  assert.equal(extractSiweDomain('thirdeye-ai-alpha.vercel.app:443 wants you to sign in with your Ethereum account:'), 'thirdeye-ai-alpha.vercel.app')
  assert.equal(extractSiweDomain('hello world'), null)
  assert.equal(extractSiweDomain(''), null)
})

test('hosts are compared as bare hostnames, whichever header or proxy produced them', () => {
  assert.equal(normalizeHost('Thirdeye-AI-Alpha.Vercel.App'), HOST)
  assert.equal(normalizeHost('thirdeye-ai-alpha.vercel.app:443'), HOST)
  assert.equal(normalizeHost('https://thirdeye-ai-alpha.vercel.app/path'), HOST)
  assert.equal(normalizeHost('thirdeye-ai-alpha.vercel.app, edge.internal'), HOST)
  assert.equal(normalizeHost(''), null)
  assert.deepEqual(
    allowedSiweHosts({ forwardedHost: 'thirdeye.ai', host: HOST, allowlist: 'thirdeye.ai, www.thirdeye.ai' }),
    ['thirdeye.ai', HOST, 'www.thirdeye.ai']
  )
})

test('a tolerant parse is accepted in production when the domain is one of ours', () => {
  const d = decideSiwe({ messageDomain: HOST, allowedHosts: [HOST], strictParseFailed: true, nodeEnv: 'production' })
  assert.equal(d.ok, true)
  assert.equal(d.lenient, true)
})

test('a tolerant parse is still refused when the domain is foreign or unknown', () => {
  const foreign = decideSiwe({ messageDomain: 'evil.example', allowedHosts: [HOST], strictParseFailed: true, nodeEnv: 'production' })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.reason, 'domain mismatch')
  const unknown = decideSiwe({ allowedHosts: [HOST], strictParseFailed: true, nodeEnv: 'production' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'message could not be parsed as EIP-4361')
})

test('the older escapes still behave: development, and the explicit opt-ins', () => {
  assert.equal(decideSiwe({ strictParseFailed: true, nodeEnv: 'development' }).ok, true)
  assert.equal(decideSiwe({ strictParseFailed: true, nodeEnv: 'production', allowLenient: true }).ok, true)
  assert.equal(
    decideSiwe({ messageDomain: 'evil.example', allowedHosts: [HOST], strictParseFailed: false, nodeEnv: 'production', allowDomainMismatch: true }).ok,
    true
  )
})

/* ---------------- the route ---------------- */

test('the nonce endpoint states the domain the message must name', async () => {
  const app = makeApp()
  const { nonce, domain } = await issueNonce(app, '203.0.113.11')
  assert.match(nonce, /^[0-9a-f]{32}$/)
  assert.equal(domain, HOST)
})

test('a CRLF message — what a mobile wallet can hand back — signs in', async () => {
  const app = makeApp()
  const { nonce } = await issueNonce(app, '203.0.113.12')
  const message = buildSiwe({ nonce, eol: '\r\n' })
  const signature = await account.signMessage({ message })
  const r = await verify(app, '203.0.113.12', message, signature)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.user.wallet, account.address.toLowerCase())
})

test('a signature over the normalised text is accepted too, since some wallets re-serialise', async () => {
  const app = makeApp()
  const { nonce } = await issueNonce(app, '203.0.113.13')
  const message = buildSiwe({ nonce, eol: '\r\n' })
  const signature = await account.signMessage({ message: normalizeSiweText(message) })
  const r = await verify(app, '203.0.113.13', message, signature)
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('a message missing EIP-4361 fields signs in, and the tolerant path is recorded', async () => {
  const app = makeApp()
  const { nonce, domain } = await issueNonce(app, '203.0.113.14')
  const message = buildSiwe({ nonce, domain: domain ?? HOST, minimal: true })
  const signature = await account.signMessage({ message })
  const r = await verify(app, '203.0.113.14', message, signature)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const row = await lastDiagnostic()
  assert.equal(row.outcome, 'accepted')
  assert.equal(row.reason, 'lenient_accepted')
  assert.equal(row.lenient, true)
})

test('a message naming another site is refused, with the reason, and recorded', async () => {
  const app = makeApp()
  const { nonce } = await issueNonce(app, '203.0.113.15')
  const message = buildSiwe({ nonce, domain: 'evil.example' })
  const signature = await account.signMessage({ message })
  const r = await verify(app, '203.0.113.15', message, signature)
  assert.equal(r.status, 401)
  assert.equal(r.body.error.reason, 'domain mismatch')
  const row = await lastDiagnostic()
  assert.equal(row.outcome, 'rejected')
  assert.equal(row.reason, 'domain mismatch')
  assert.equal(row.message_domain, 'evil.example')
  assert.equal(row.request_host, HOST)
})

test('the diagnostic table carries no nonce, address or signature', async () => {
  const app = makeApp()
  const { nonce } = await issueNonce(app, '203.0.113.16')
  const message = buildSiwe({ nonce, domain: 'evil.example' })
  const signature = await account.signMessage({ message })
  await verify(app, '203.0.113.16', message, signature)
  const cols = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_signin_log'")
  const names = (cols.rows ?? cols).map((r: any) => r.column_name)
  for (const forbidden of ['nonce', 'address', 'signature', 'message']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be stored`)
  }
  const rows = await query('SELECT * FROM auth_signin_log')
  const flat = JSON.stringify(rows.rows ?? rows)
  assert.ok(!flat.includes(nonce), 'the nonce leaked into diagnostics')
  assert.ok(!flat.toLowerCase().includes(account.address.toLowerCase()), 'the address leaked into diagnostics')
})

test('the deployment really is in production mode, so these tests prove the production rule', () => {
  assert.equal(env.nodeEnv, 'production')
})
