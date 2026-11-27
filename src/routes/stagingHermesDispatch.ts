import { randomUUID, timingSafeEqual } from 'node:crypto'
import { query, one, migrate } from '../db/index.js'
import type { SessionApp } from '../lib/session.js'
import type { AgentRow } from '../agents/runner.js'
import { runAgent } from '../agents/runner.js'
import { newCorrelationId } from '../agents/audit-log.js'
import { STAGING_SHARED_BUDGET_CAP_MICROS } from '../agents/shared-budget.js'

const TARGET_SHA = 'dd956e60524020d1e8218bd1652d1cab356d2414'
const ROOT_AGENT_ID = 'tdt_hermes'
const REVIEWERS = [
  { id: 'tdt_qa', role: 'QA' },
  { id: 'tdt_sentinel', role: 'SENTINEL' },
] as const

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function error(c: any, status: number, message: string) {
  return c.json({ error: { message, type: status === 401 ? 'auth' : 'staging_dispatch', code: status } }, status as 400 | 401 | 404 | 503)
}

function parseArtifactIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] }
  }
  return []
}

/**
 * One-shot, Preview-only dispatch. It is deliberately separate from the general cron route:
 * request fields cannot select agents, tools, models, prompts, URLs, or budgets.
 */
export function registerStagingHermesDispatchRoute(app: SessionApp): void {
  app.post('/api/ops/staging/hermes-review', async (c) => {
    const expectedSecret = process.env.STAGING_DISPATCH_SECRET || ''
    const authorization = c.req.header('authorization') || ''
    const suppliedSecret = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!expectedSecret || !sameSecret(suppliedSecret, expectedSecret)) {
      return error(c, 401, 'Unauthorized')
    }

    // Environment identity is checked before any database read or dispatch write.
    const deployedSha = process.env.VERCEL_GIT_COMMIT_SHA || ''
    if (
      process.env.VERCEL_ENV !== 'preview' ||
      !deployedSha ||
      !process.env.STAGING_DISPATCH_DEPLOYMENT_SHA ||
      deployedSha !== process.env.STAGING_DISPATCH_DEPLOYMENT_SHA
    ) {
      return error(c, 404, 'Staging dispatch is unavailable in this environment')
    }

    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(c, 400, 'Invalid JSON body')
    const keys = Object.keys(body)
    if (keys.some((key) => !['dispatch_id', 'target_sha'].includes(key))) {
      return error(c, 400, 'Unknown request fields are not allowed')
    }
    if (typeof body.dispatch_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(body.dispatch_id)) {
      return error(c, 400, 'dispatch_id must be an owner-issued 8-128 character identifier')
    }
    if (body.target_sha !== TARGET_SHA) return error(c, 400, 'target_sha must equal the approved immutable review revision')
    if (process.env.STAGING_DISPATCH_ENABLED !== 'true') return error(c, 503, 'Staging dispatch is disabled pending independent approval')

    // This route is registered ahead of the general API bootstrap middleware. Migrate only
    // after authentication, Preview identity, and strict request validation have passed.
    await migrate()

    const dispatchId = body.dispatch_id
    const correlationId = newCorrelationId()
    const rootRunId = randomUUID()

    // Insert is the one-shot idempotency claim. Only the request that inserts the row may run.
    const claimed = await query(
      `INSERT INTO staging_agent_dispatches
        (id, target_sha, status, budget_cap_usd_micros, correlation_id, root_run_id)
       VALUES ($1, $2, 'running', $3, $4, $5)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [dispatchId, TARGET_SHA, STAGING_SHARED_BUDGET_CAP_MICROS, correlationId, rootRunId]
    )
    if (claimed.rowCount === 0) {
      const prior = await one(
        `SELECT id, target_sha, status, spent_usd_micros, root_run_id, correlation_id
           FROM staging_agent_dispatches WHERE id = $1`,
        [dispatchId]
      )
      return c.json({
        dispatch_id: dispatchId,
        idempotent_replay: true,
        status: prior?.status ?? 'unknown',
        target_sha: prior?.target_sha ?? TARGET_SHA,
        spent_usd_micros: Number(prior?.spent_usd_micros ?? 0),
        root_run_id: prior?.root_run_id ?? null,
        correlation_id: prior?.correlation_id ?? null,
      }, 200)
    }

    try {
      const root = await one(`SELECT * FROM agents WHERE id = $1 AND status = 'active'`, [ROOT_AGENT_ID])
      if (!root) throw new Error('Canonical HERMES agent is missing or inactive')
      const reviewers: any[] = []
      for (const reviewer of REVIEWERS) {
        const row = await one(
          `SELECT * FROM agents WHERE id = $1 AND user_id = $2 AND status = 'active'`,
          [reviewer.id, root.user_id]
        )
        if (!row) throw new Error(`Canonical ${reviewer.role} reviewer is missing, inactive, or owned by another account`)
        reviewers.push(row)
      }
      const user = await one('SELECT * FROM users WHERE id = $1', [root.user_id])
      if (!user) throw new Error('HERMES owner account is unavailable')

      // Remove every persisted capability not needed for this read-only review.
      const hermes = {
        ...(root as AgentRow),
        mcp_servers: [],
        x402_enabled: false,
        x402_allowed_sellers: [],
        repo_access: 'read',
        can_delegate: true,
        budget_usd_micros: STAGING_SHARED_BUDGET_CAP_MICROS,
        max_steps: Math.min(Number(root.max_steps) || 8, 8),
      } as AgentRow

      const reviewInput = [
        'You are HERMES performing one bounded, read-only staging review mission.',
        'Review only PR https://github.com/hakuramasam/thirdeye-ai/pull/116 at immutable commit ' + TARGET_SHA + '.',
        'Independently delegate one separate review task to QA (canonical agent tdt_qa) and one to SENTINEL (canonical agent tdt_sentinel).',
        'QA must focus on correctness, tests, regressions, and acceptance criteria. SENTINEL must focus on security boundaries, authorization, secrets, concurrency, and spend enforcement.',
        'Both reviewers must inspect the exact same commit SHA and produce separate evidence-backed reports. Do not combine or rewrite their source reports.',
        'You may summarize their results, but must not claim approval unless both child runs complete successfully with separate durable artifacts.',
        'This dispatch is read-only. Do not merge, deploy, modify files, use wallets, make x402 payments, call arbitrary URLs, or request secrets.',
      ].join('\n')

      const rootResult = await runAgent(hermes, reviewInput, user, {
        runId: rootRunId,
        correlationId,
        stagingDispatch: {
          dispatchId,
          allowedChildAgentIds: reviewers.map((r) => String(r.id)),
          maxDelegationDepth: 1,
          targetSha: TARGET_SHA,
        },
        roster: 'QA, SENTINEL',
      })

      const reviewerEvidence: any[] = []
      for (const reviewer of reviewers) {
        const events = await query(
          `SELECT run_id, event_type, status, artifact_ids
             FROM agent_audit_events
            WHERE correlation_id = $1 AND agent_id = $2
            ORDER BY insert_seq ASC`,
          [correlationId, reviewer.id]
        )
        const completed = events.rows.find((e) => e.event_type === 'run.completed' && e.status === 'succeeded')
        const runCreated = events.rows.find((e) => e.event_type === 'run.created')
        const childRunId = completed?.run_id ?? runCreated?.run_id ?? null
        const artifacts = childRunId
          ? await query('SELECT id, content_sha256 FROM agent_artifacts WHERE correlation_id = $1 AND run_id = $2', [correlationId, childRunId])
          : { rows: [] }
        reviewerEvidence.push({
          agent_id: reviewer.id,
          role: reviewer.name,
          run_id: childRunId,
          completed: Boolean(completed),
          artifacts: artifacts.rows.map((a: any) => ({ id: a.id, sha256: a.content_sha256 })),
          artifact_ids_from_audit: completed ? parseArtifactIds(completed.artifact_ids) : [],
        })
      }

      const allApproved = rootResult.status === 'success' && reviewerEvidence.every((r) => r.completed && r.artifacts.length > 0)
      const ledger = await one(
        'SELECT reserved_usd_micros, spent_usd_micros, status FROM staging_agent_dispatches WHERE id = $1',
        [dispatchId]
      )
      const status = ledger?.status === 'over_budget' ? 'over_budget' : allApproved ? 'completed' : 'failed'
      await query(
        `UPDATE staging_agent_dispatches
            SET status = $2, result_summary = $3, completed_at = now()
          WHERE id = $1 AND status <> 'over_budget'`,
        [dispatchId, status, JSON.stringify({ root_status: rootResult.status, reviewerEvidence })]
      )

      return c.json({
        dispatch_id: dispatchId,
        target_sha: TARGET_SHA,
        status,
        root: { agent_id: ROOT_AGENT_ID, run_id: rootRunId, status: rootResult.status },
        reviewers: reviewerEvidence,
        budget: {
          cap_usd_micros: STAGING_SHARED_BUDGET_CAP_MICROS,
          reserved_usd_micros: Number(ledger?.reserved_usd_micros ?? 0),
          spent_usd_micros: Number(ledger?.spent_usd_micros ?? 0),
        },
        correlation_id: correlationId,
      }, allApproved && status === 'completed' ? 200 : 422)
    } catch (e: any) {
      await query(
        `UPDATE staging_agent_dispatches SET status = CASE WHEN status = 'over_budget' THEN status ELSE 'failed' END,
           result_summary = $2, completed_at = now() WHERE id = $1`,
        [dispatchId, String(e?.message ?? e).slice(0, 500)]
      ).catch(() => null)
      return error(c, 503, 'Staging dispatch failed closed; inspect the durable dispatch audit record')
    }
  })
}
