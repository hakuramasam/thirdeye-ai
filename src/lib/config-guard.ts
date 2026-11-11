/**
 * Legible refusal for a deployment whose signing secrets failed validation.
 *
 * The strictness itself lives in security.ts and env.ts: a production boot with a missing,
 * development, short or duplicated secret is still refused. What this module fixes is the way
 * that refusal surfaced. It used to throw at module scope, so every request died as a bare 500
 * `FUNCTION_INVOCATION_FAILED` and even the health endpoint could not say why, which turned a
 * one-line environment fix into a debugging session about Vercel.
 *
 * The rule here: name the problem, never the value. A problem list carries variable names and a
 * short reason, never secret material, because these bodies are served to unauthenticated callers.
 */

import type { SecretProblem } from './security.js'

/** Kept reachable on a misconfigured deployment so the refusal can be observed from outside. */
export const HEALTH_PATH = '/api/healthz'

export type ConfigStatus = { ok: boolean; problems: SecretProblem[] }

export function configStatus(problems: SecretProblem[]): ConfigStatus {
  return { ok: problems.length === 0, problems: problems.map((p) => ({ name: p.name, problem: p.problem })) }
}

/** The 503 body served to every API caller except the health endpoint. */
export function misconfiguredBody(problems: SecretProblem[]) {
  return {
    error: {
      type: 'misconfigured',
      message:
        'This deployment refused to start because its signing secrets are unsafe. ' +
        'Fix the environment variables named in problems, then redeploy.',
      problems: configStatus(problems).problems,
    },
  }
}

/**
 * Place this BEFORE any handler that touches sessions, keys or the database, so a misconfigured
 * deployment does no work at all rather than failing later inside whichever route ran first.
 */
export function configGuard(problems: SecretProblem[]) {
  return async (c: any, next: () => Promise<void>) => {
    if (problems.length === 0) return next()
    if (c.req.path === HEALTH_PATH) return next()
    return c.json(misconfiguredBody(problems), 503)
  }
}

/**
 * The health payload. `ok` stays false while the configuration is unsafe, so a monitor fails on
 * the body and not only on the status code, and `config` carries the reason.
 */
export function healthzBody(problems: SecretProblem[], mode: string, now: string = new Date().toISOString()) {
  const config = configStatus(problems)
  return { ok: config.ok, mode, config, time: now }
}
