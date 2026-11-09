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
