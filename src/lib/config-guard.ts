/**
 * Legible refusal for a deployment whose configuration failed validation: signing secrets first,
 * then a serverless runtime with no database, which would otherwise serve an in-memory database.
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

/**
 * Liveness, as distinct from readiness.
 *
 * Readiness (healthz) answers "may this process serve traffic": configuration plus a reachable
 * database, which is what a load balancer should act on. Liveness answers "is the process up",
 * which must not depend on the database, or a database outage becomes a restart loop that fixes
 * nothing. Both are reachable while misconfigured, because a probe that dies on the fault it
 * reports is unreadable from outside.
 */
export const LIVE_PATH = '/api/livez'

/** Paths the guard lets through: the two health probes and nothing else. */
export const PROBE_PATHS = [HEALTH_PATH, LIVE_PATH]

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
        'This deployment refused to start because its configuration is unsafe. ' +
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
    if (PROBE_PATHS.includes(c.req.path)) return next()
    return c.json(misconfiguredBody(problems), 503)
  }
}

/**
 * The readiness payload. `ok` stays false while the configuration is unsafe or the database is
 * unreachable, so a monitor fails on the body and not only on the status code.
 *
 * `database` is supplied by the caller that can actually reach a database. When it is omitted the
 * payload says so rather than claiming a readiness it never measured, because a health body that
 * reports ok without touching the database is the exact deception this module exists to remove.
 */
export type DatabaseProbe = { ok: boolean; ms?: number; error?: string }

export function healthzBody(
  problems: SecretProblem[],
  mode: string,
  now: string = new Date().toISOString(),
  database?: DatabaseProbe | null
) {
  const config = configStatus(problems)
  const db = database ?? null
  return {
    ok: config.ok && (db ? db.ok : true),
    mode,
    config,
    database: db,
    time: now,
  }
}

/** Liveness: uptime carries no database claim, so it stays true while the database is down. */
export function livezBody(mode: string, now: string = new Date().toISOString()) {
  return { ok: true, mode, time: now }
}
