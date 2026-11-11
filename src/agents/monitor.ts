/**
 * Log monitoring for the development team.
 *
 * Sam's ask: keep a readable history of what the agents actually did, and raise an alert when a
 * run's behaviour disagrees with the project or with the declared pipeline, so HERMES can be told
 * to fix it rather than the mismatch being discovered later by a customer.
 *
 * Design rule that matters: a detector must be a pure function over rows. Anything that talks to a
 * database, a model or a clock lives in `auditAgents`, so every rule can be tested without mocking
 * a network and a bad rule cannot corrupt a run.
 *
 * The second rule: an alert is evidence with a dedupe key, never a vibe. Two identical findings
 * collapse into one row, so a permanently broken agent cannot generate a thousand pages of noise
 * and train everyone to ignore the channel.
 */

import { createHash } from 'node:crypto'
import { query, one } from '../db/index.js'
import { newId } from '../lib/env.js'

export type Severity = 'low' | 'medium' | 'high'

export interface RunRow {
  id: string
  agent_id: string
  status: string
  input?: string | null
  output?: string | null
  error?: string | null
  tool_calls?: number | null
  spend_usd_micros?: number | string | null
  created_at: string | Date
}

export interface EventRow {
  run_id: string
  tool: string
  ok: boolean
  refused?: boolean | null
  args_excerpt?: string | null
  result_excerpt?: string | null
}

export interface Finding {
  code: string
  severity: Severity
  agent_id: string | null
  run_id: string | null
  summary: string
  evidence: Record<string, unknown>
}

/** Runs finish with 'success' in production and 'completed' in the schema docs; treat both as done. */
export function isSuccess(status?: string | null): boolean {
  return status === 'success' || status === 'completed' || status === 'ok'
}

/** Words a run uses when it believes it succeeded. */
const CLAIM = /\b(deployed|shipped|is live|now live|fixed|resolved|passing|verified|completed|done)\b/i

/** Words that turn a claim into a measurement. A claim without one of these is a guess. */
const EVIDENCE = /\b(healthz|status 200|tsc|tests?\b|\d+\s*\/\s*\d+|commit [0-9a-f]{7}|\b[0-9a-f]{7,40}\b|PR #\d+|sha)\b/i

export function claimsSuccess(text?: string | null): boolean {
  return !!text && CLAIM.test(text)
}

export function showsEvidence(text?: string | null): boolean {
  return !!text && EVIDENCE.test(text)
}

function minutesSince(at: string | Date, now: number): number {
  const t = typeof at === 'string' ? Date.parse(at) : at.getTime()
  if (Number.isNaN(t)) return 0
  return (now - t) / 60_000
}

/**
 * Every rule, in one place. Ordered by how much damage the condition does if it goes unnoticed.
 */
export function detectFindings(
  runs: RunRow[],
  events: EventRow[],
  opts: { now?: number; staleMinutes?: number; budgets?: Record<string, number> } = {}
): Finding[] {
  const now = opts.now ?? Date.now()
  const staleMinutes = opts.staleMinutes ?? 15
  const budgets = opts.budgets ?? {}
  const out: Finding[] = []
  const byRun = new Map<string, EventRow[]>()
  for (const e of events ?? []) {
    const list = byRun.get(e.run_id) ?? []
    list.push(e)
    byRun.set(e.run_id, list)
  }

  const failuresByAgent = new Map<string, number>()
  for (const r of runs) {
    if (r.status === 'error') failuresByAgent.set(r.agent_id, (failuresByAgent.get(r.agent_id) ?? 0) + 1)
  }

  for (const r of runs) {
    const spend = Number(r.spend_usd_micros ?? 0)
    const calls = Number(r.tool_calls ?? 0)
    const runEvents = byRun.get(r.id) ?? []

    // A run left open means the process died mid-work. Nothing downstream can be trusted.
    if (r.status === 'running' && minutesSince(r.created_at, now) > staleMinutes) {
      out.push({
        code: 'stuck_run',
        severity: 'high',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: `Run has been 'running' for ${Math.round(minutesSince(r.created_at, now))} minutes, so it is dead rather than slow.`,
        evidence: { status: r.status, created_at: r.created_at, spend },
      })
    }

    if (r.status === 'error') {
      out.push({
        code: 'failed_run',
        severity: 'medium',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: `Run failed: ${String(r.error ?? 'no error recorded').slice(0, 180)}`,
        evidence: { error: String(r.error ?? '').slice(0, 400), spend },
      })
    }

    // Money spent, nothing done: usually a model that narrated instead of acting.
    if (isSuccess(r.status) && spend > 0 && calls === 0) {
      out.push({
        code: 'silent_spend',
        severity: 'low',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: `Spent ${spend} micros without calling a single tool.`,
        evidence: { spend, tool_calls: calls },
      })
    }

    // The failure mode that matters most: reporting success without proof.
    if (isSuccess(r.status) && claimsSuccess(r.output) && !showsEvidence(r.output)) {
      out.push({
        code: 'unverified_claim',
        severity: 'high',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: 'Report claims the work is done but quotes no measurement (sha, test count, HTTP status).',
        evidence: { output: String(r.output ?? '').slice(0, 400) },
      })
    }

    // A write that the guard refused is a process mismatch worth seeing, not a crash to hide.
    const refusedWrite = runEvents.find((e) => e.tool === 'repo_write' && (e.refused || !e.ok))
    if (refusedWrite) {
      out.push({
        code: 'write_refused',
        severity: 'high',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: `A repo_write attempt was refused: ${String(refusedWrite.result_excerpt ?? 'no reason recorded').slice(0, 160)}`,
        evidence: { args: String(refusedWrite.args_excerpt ?? '').slice(0, 200) },
      })
    }

    // Wrote code but produced no evidence anywhere in the same run.
    const wrote = runEvents.some((e) => e.tool === 'repo_write' && e.ok && !e.refused)
    if (wrote && !showsEvidence(r.output)) {
      out.push({
        code: 'write_without_verify',
        severity: 'high',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: 'Opened a pull request but attached no typecheck, test count or health result.',
        evidence: { output: String(r.output ?? '').slice(0, 300) },
      })
    }

    // A confidently wrong date is a real failure mode: measured live on 2026-11-10 when DOCS
    // answered "2024-07-18" after a tool call. Cheap to catch, and it protects every future
    // report that quotes a version, a date or a year.
    const years: string[] = String(r.output ?? "").match(/\b(19|20)\d{2}\b/g) ?? []
    const currentYear = new Date(now).getUTCFullYear()
    if (isSuccess(r.status) && years.length > 0 && !years.includes(String(currentYear))) {
      out.push({
        code: 'temporal_mismatch',
        severity: 'medium',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: `Output dates itself ${years.slice(0, 3).join(', ')} while the run happened in ${currentYear}.`,
        evidence: { years: years.slice(0, 5), output: String(r.output ?? '').slice(0, 200) },
      })
    }

    const budget = budgets[r.agent_id]
    if (budget && spend > budget) {
      out.push({
        code: 'budget_overrun',
        severity: 'high',
        agent_id: r.agent_id,
        run_id: r.id,
        summary: `Spent ${spend} micros against a ${budget} micro budget.`,
        evidence: { spend, budget },
      })
    }
  }

  for (const [agentId, count] of failuresByAgent) {
    if (count >= 3) {
      out.push({
        code: 'repeat_failure',
        severity: 'medium',
        agent_id: agentId,
        run_id: null,
        summary: `${count} failed runs for the same agent in this window, which is a pattern rather than bad luck.`,
        evidence: { failures: count },
      })
    }
  }

  return out
}

/** Stable key so the same condition on the same run alerts once. */
export function dedupeKey(f: Finding): string {
  return `${f.code}:${f.run_id ?? f.agent_id ?? 'global'}`
}

/** Strip anything credential-shaped before a log line or an alert stores it. */
export function scrub(text: string, max = 400): string {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(?<=bearer\s)[A-Za-z0-9._-]{10,}/gi, '***')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh***')
    .slice(0, max)
}

export interface AuditResult {
  runs: number
  events: number
  findings: number
  created: number
  /** Run ids the orchestrator accepted, in dispatch order. Empty when nothing was handed over. */
  dispatched: string[]
  /** Why nothing was handed to HERMES, when a dispatch was asked for. */
  dispatch_skipped?: 'no_high_findings' | 'hermes_not_found' | 'owner_not_found' | 'replayed'
  /** Set when the orchestrator could not be run at all. */
  dispatch_error?: 'runner_failed'
}

/**
 * The run id for one dispatch, derived from the findings it carries.
 *
 * Same brief, same id, which is what makes a repeated audit harmless: `runAgent` inserts the run
 * id or replays the recorded one, so a second call returns the first run instead of paying for
 * another. Shaped like a uuid because every other run id is one and downstream readers assume it.
 */
export function dispatchRunId(keys: string[]): string {
  const h = createHash('sha256').update([...keys].sort().join('|')).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Read the recent log, run every detector, store what is new, and hand the worst of it to HERMES.
 *
 * Dispatch is deliberately capped at three high-severity findings per pass: an orchestrator told to
 * fix nine things at once fixes none of them, and each dispatch spends real money.
 */
export async function auditAgents(opts: {
  hours?: number
  dispatch?: boolean
  hermesId?: string
  ownerUserId?: string
  maxDispatch?: number
} = {}): Promise<AuditResult> {
  const hours = Math.min(Math.max(opts.hours ?? 24, 1), 168)
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()

  // query() is not generic here, so results are narrowed by cast rather than by type parameter.
  const runsRes: any = await query(
    `SELECT id, agent_id, status, input, output, error, tool_calls, spend_usd_micros, created_at
       FROM agent_runs WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 500`,
    [since]
  )
  const runs: RunRow[] = runsRes.rows ?? []

  let events: EventRow[] = []
  try {
    const evRes: any = await query(
      `SELECT run_id, tool, ok, refused, args_excerpt, result_excerpt
         FROM agent_run_events WHERE created_at >= $1 ORDER BY created_at ASC LIMIT 2000`,
      [since]
    )
    events = evRes.rows ?? []
  } catch {
    events = [] // the events table is new; an older database simply has no history yet
  }

  const agentRes: any = await query(`SELECT id, budget_usd_micros FROM agents WHERE id LIKE 'tdt_%'`)
  const agentRows: Array<{ id: string; budget_usd_micros: number | string | null }> = agentRes.rows ?? []
  const budgets: Record<string, number> = {}
  for (const a of agentRows) if (a.budget_usd_micros != null) budgets[a.id] = Number(a.budget_usd_micros)

  const findings = detectFindings(runs, events, { budgets })

  let created = 0
  const fresh: Finding[] = []
  for (const f of findings) {
    const key = dedupeKey(f)
    const row = await one(
      `INSERT INTO agent_alerts (id, code, severity, agent_id, run_id, summary, evidence, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [newId(), f.code, f.severity, f.agent_id, f.run_id, scrub(f.summary, 300), JSON.stringify(f.evidence), key]
    )
    if (row) {
      created++
      fresh.push(f)
    }
  }

  const dispatched: string[] = []
  let dispatchSkipped: AuditResult['dispatch_skipped']
  let dispatchError: AuditResult['dispatch_error']

  if (opts.dispatch) {
    const cap = Math.min(opts.maxDispatch ?? 3, 3)
    const worst = fresh.filter((f) => f.severity === 'high').slice(0, cap)
    if (worst.length === 0) {
      dispatchSkipped = 'no_high_findings'
    } else {
      // HERMES owns the team, so its owner is the user this brief belongs to. Requiring the caller
      // to name that user made a real dispatch look like an empty one: the admin route passes only
      // the orchestrator id, so `dispatch: true` answered `dispatched: []` while alerts were being
      // created, and no finding ever reached HERMES. Fail closed if either row is missing, rather
      // than inventing an owner.
      const hermesId = opts.hermesId ?? 'tdt_hermes'
      const hermes: any = await one(`SELECT * FROM agents WHERE id = $1`, [hermesId])
      if (!hermes) {
        dispatchSkipped = 'hermes_not_found'
      } else {
        const ownerId = opts.ownerUserId ?? hermes.user_id ?? null
        const owner: any = ownerId ? await one(`SELECT * FROM users WHERE id = $1`, [ownerId]) : null
        if (!owner) {
          dispatchSkipped = 'owner_not_found'
        } else {
          const keys = worst.map(dedupeKey)
          const runId = dispatchRunId(keys)
          const brief = [
            'Monitoring raised findings against your team. Decide what to fix and which agent owns it.',
            'You hold no authority to merge or deploy: your output is a decision plus a task, or a pull request.',
            '',
            ...worst.map((f, i) => `${i + 1}. [${f.code}] ${f.agent_id ?? 'team'}: ${f.summary}`),
            '',
            'For each: state whether it is a real defect or noise, what the fix is, and who does it. Keep it short.',
          ].join('\n')
          try {
            const { runAgent } = await import('./runner.js')
            const res: any = await runAgent(hermes, brief, owner, { runId })
            // Record which run answered which alert, so the trail goes both ways.
            for (const key of keys) {
              await query(`UPDATE agent_alerts SET dispatch_run_id = $1 WHERE dedupe_key = $2`, [runId, key])
            }
            dispatched.push(runId)
            if (res?.replayed) dispatchSkipped = 'replayed'
          } catch {
            // The audit still returns its findings; only the handoff is reported as failed.
            dispatchError = 'runner_failed'
          }
        }
      }
    }
  }

  return {
    runs: runs.length,
    events: events.length,
    findings: findings.length,
    created,
    dispatched,
    ...(dispatchSkipped ? { dispatch_skipped: dispatchSkipped } : {}),
    ...(dispatchError ? { dispatch_error: dispatchError } : {}),
  }
}

/** Record one tool call. Never throws: logging must not break a run the owner already paid for. */
export async function logRunEvent(e: {
  runId: string
  agentId: string
  seq: number
  tool: string
  argsExcerpt?: string
  resultExcerpt?: string
}): Promise<void> {
  const text = String(e.resultExcerpt ?? '')
  const refused = /\brefused\b|\bnot permitted\b|\bwithheld\b|\bdenied\b/i.test(text)
  const ok = !refused && !/^Tool error|^repo_write failed/i.test(text.trim())
  await query(
    `INSERT INTO agent_run_events (id, run_id, agent_id, seq, tool, ok, refused, args_excerpt, result_excerpt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), e.runId, e.agentId, e.seq, e.tool, ok, refused, scrub(e.argsExcerpt ?? '', 200), scrub(text, 300)]
  )
}
