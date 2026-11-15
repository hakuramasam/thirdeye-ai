/**
 * Startup and authentication guards.
 *
 * These exist because the two cheapest ways to lose every account on a platform are a
 * development secret that shipped to production and an authentication check that logs a
 * problem instead of refusing it. Both were present here.
 */

/** Values that must never be usable in production, because they are public in the repo. */
export const DEV_SECRET_VALUES = new Set([
  'thirdeye-dev-session-secret',
  'thirdeye-dev-master-key',
  'changeme',
  'secret',
  'development',
  '',
])

export type SecretProblem = { name: string; problem: string }

/**
 * Validate the signing secrets. Pure, so the failure modes are testable without booting.
 * Returns the problems found; an empty array means the configuration is acceptable.
 */
export function validateSecrets(
  input: { sessionSecret?: string; masterKey?: string; nodeEnv?: string },
  minLength = 32
): SecretProblem[] {
  const problems: SecretProblem[] = []
  const isProd = (input.nodeEnv ?? 'development') === 'production'
  const check = (name: string, value: string | undefined) => {
    const v = value ?? ''
    if (DEV_SECRET_VALUES.has(v)) problems.push({ name, problem: 'missing or a known development value' })
    else if (v.length < minLength) problems.push({ name, problem: `shorter than ${minLength} characters` })
  }
  // In development the defaults stay usable so local work is not blocked.
  if (!isProd) return problems
  check('SESSION_SECRET', input.sessionSecret)
  check('MASTER_KEY', input.masterKey)
  if (input.sessionSecret && input.masterKey && input.sessionSecret === input.masterKey) {
    problems.push({ name: 'SESSION_SECRET/MASTER_KEY', problem: 'must not be the same value' })
  }
  return problems
}

export type SiweDecision = { ok: boolean; reason?: string; lenient: boolean }

/**
 * A deployment with no database is not demo mode, it is a data-loss bug.
 *
 * `dbMode()` falls back to PGlite whenever no connection string is set, and on serverless PGlite
 * runs at `memory://`. Every request then reads an empty database and every write is discarded on
 * the next cold start, answering 200 the whole time, with nothing in the logs to say so. A local
 * check-out may run that way on purpose (the file-backed dev database and the test suite both do),
 * so the refusal is scoped to a deployment: serverless, or NODE_ENV=production.
 *
 * The check names the variable and never the value, like the secret rules beside it.
 */
export function validateDatabase(input: {
  databaseUrl?: string
  /** The variable the runtime actually read. Previews prefer PREVIEW_DATABASE_URL. */
  databaseUrlVar?: string
  isServerless?: boolean
  nodeEnv?: string
}): SecretProblem[] {
  const deployed = Boolean(input.isServerless) || (input.nodeEnv ?? 'development') === 'production'
  if (!deployed) return []
  const problems: SecretProblem[] = []
  // Name the variable in play, not the conventional one: a preview reads PREVIEW_DATABASE_URL, so
  // reporting DATABASE_URL would send an operator to a variable that is not being consulted.
  const name = input.databaseUrlVar || 'DATABASE_URL'
  const url = String(input.databaseUrl ?? '').trim()
  if (!url) {
    problems.push({
      name,
      problem:
        'missing on a deployment, so the app would fall back to its local database (an in-memory one on serverless) and no write would reach production',
    })
    return problems
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    problems.push({ name, problem: 'not a postgres:// connection string' })
  }
  return problems
}

/**
 * Undo the transport noise that makes a valid EIP-4361 message unparseable.
 *
 * A mobile wallet's in-app browser, a transcoding proxy browser (data-saver "extreme" modes, which
 * are common on slow connections) or a wallet that renders the message through a DOM textarea can
 * hand back a message whose line endings are CRLF, whose trailing whitespace is padded, or which
 * carries a BOM or zero-width joiners. None of that is part of what the user agreed to; it is what
 * the transport did to it. Normalising it for PARSING is safe because the signature is still
 * verified over the exact bytes the wallet signed.
 */
export function normalizeSiweText(raw: string): string {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '')
}

/**
 * Recover the domain from the first line of a SIWE message.
 *
 * The first line is `${domain} wants you to sign in with your Ethereum account:` and it is the only
 * part of the message that a strict parser could not have reached differently, so it can be trusted
 * to at least let us decide whether the message came from a host we serve.
 */
export function extractSiweDomain(raw: string): string | null {
  const firstLine = normalizeSiweText(raw).split('\n')[0]?.trim() ?? ''
  const m = firstLine.match(/^([A-Za-z0-9.-]+(?::\d+)?)\s+wants you to sign in with your Ethereum account:$/i)
  return m ? m[1].replace(/:\d+$/, '').toLowerCase() : null
}

/** Reduce a Host header, an x-forwarded-host chain or an allowlist entry to a bare hostname. */
export function normalizeHost(value?: string | null): string | null {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  // x-forwarded-host can be "client.example, edge.example"; the client-facing one is first.
  const first = raw.split(',')[0].trim()
  const noScheme = first.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const hostname = noScheme.split('/')[0].replace(/:\d+$/, '')
  return hostname || null
}

/**
 * Every hostname this deployment may legitimately be reached on.
 *
 * The request headers come first, because a proxy browser can present a host the operator never
 * configured. SIWE_ALLOWED_DOMAINS exists for the hosts we own that the headers cannot always
 * carry: a custom domain, the short production alias, a partner subdomain.
 */
export function allowedSiweHosts(input: {
  host?: string | null
  forwardedHost?: string | null
  allowlist?: string | null
}): string[] {
  const out: string[] = []
  const add = (value?: string | null) => {
    const h = normalizeHost(value)
    if (h && !out.includes(h)) out.push(h)
  }
  add(input.forwardedHost)
  add(input.host)
  for (const entry of String(input.allowlist ?? '').split(',')) add(entry)
  return out
}

/**
 * Decide whether a SIWE login may proceed.
 *
 * Three things must hold: the nonce is ours and unused, the message is fresh, and the signature
 * verifies over the exact bytes received. The domain check exists on top of that because a
 * phishing site can otherwise collect a signature over a nonce we issued and replay it.
 *
 * A message the strict EIP-4361 parser could not read is still accepted in production when the
 * domain could be recovered and is one of OUR hosts. That is not a weakening: the older rule
 * refused those logins outright while the fields it wanted (address, nonce, issued-at) are all
 * recovered independently and validated anyway, which is why mobile sign-in kept failing with
 * "signature does not match this site or message format" on a message we generated ourselves.
 * When the domain cannot be recovered at all, the strict parser's refusal stands.
 */
export function decideSiwe(input: {
  messageDomain?: string | null
  host?: string | null
  /** Preferred over `host` when given: every hostname this deployment answers on. */
  allowedHosts?: string[] | null
  strictParseFailed: boolean
  nodeEnv?: string
  allowLenient?: boolean
  allowDomainMismatch?: boolean
}): SiweDecision {
  const isProd = (input.nodeEnv ?? 'development') === 'production'
  const lenient = Boolean(input.strictParseFailed)
  // The message's own domain is normalised through the same function as the hosts, so a message
  // naming "site.example:443" matches a Host header of "site.example".
  const md = normalizeHost(input.messageDomain) ?? ''
  const hosts = (input.allowedHosts?.length
    ? input.allowedHosts
    : [String(input.host ?? '')]
  )
    .map((h) => normalizeHost(h))
    .filter((h): h is string => Boolean(h))
  const domainMatches = Boolean(md) && hosts.includes(md)

  // Nothing recoverable: the strict parser's refusal stands where it matters.
  if (!md) {
    if (lenient && isProd && !input.allowLenient) {
      return { ok: false, reason: 'unparseable_message', lenient }
    }
    return { ok: true, lenient }
  }

  // No host known is not permission: with nothing to compare against, the check fails closed unless
  // an operator has explicitly waived domain matching.
  if (!hosts.length && !input.allowDomainMismatch) {
    return { ok: false, reason: 'unknown_host', lenient }
  }
  if (!domainMatches && !input.allowDomainMismatch) {
    return { ok: false, reason: 'domain_mismatch', lenient }
  }
  if (lenient && !domainMatches && isProd && !input.allowLenient) {
    return { ok: false, reason: 'unparseable_message', lenient }
  }
  return { ok: true, lenient }
}
