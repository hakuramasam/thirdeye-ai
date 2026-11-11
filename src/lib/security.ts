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
  isServerless?: boolean
  nodeEnv?: string
}): SecretProblem[] {
  const deployed = Boolean(input.isServerless) || (input.nodeEnv ?? 'development') === 'production'
  if (!deployed) return []
  const problems: SecretProblem[] = []
  const url = String(input.databaseUrl ?? '').trim()
  if (!url) {
    problems.push({
      name: 'DATABASE_URL',
      problem:
        'missing on a deployment, which would fall back to an in-memory database that loses every write on restart',
    })
    return problems
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    problems.push({ name: 'DATABASE_URL', problem: 'not a postgres:// connection string' })
  }
  return problems
}

/**
 * Decide whether a SIWE login may proceed.
 *
 * Rules: a domain that does not match the host is a rejection, not a log line, because a
 * phishing site can otherwise harvest a signature over a nonce we issued. A message the
 * strict EIP-4361 parser could not read is only accepted in development, or when an
 * operator explicitly opts in, since its fields were never validated.
 */
export function decideSiwe(input: {
  messageDomain?: string | null
  host?: string | null
  strictParseFailed: boolean
  nodeEnv?: string
  allowLenient?: boolean
  allowDomainMismatch?: boolean
}): SiweDecision {
  const isProd = (input.nodeEnv ?? 'development') === 'production'
  const lenient = Boolean(input.strictParseFailed)
  if (lenient && isProd && !input.allowLenient) {
    return { ok: false, reason: 'message could not be parsed as EIP-4361', lenient }
  }
  const md = (input.messageDomain ?? '').toLowerCase().trim()
  const host = (input.host ?? '').toLowerCase().trim()
  if (md && host && md !== host && !input.allowDomainMismatch) {
    return { ok: false, reason: 'domain mismatch', lenient }
  }
  return { ok: true, lenient }
}
