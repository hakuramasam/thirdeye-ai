/**
 * Team scorecard: is the team getting better, measured from what actually ran.
 *
 * Sam's rule: do not reward volume. Lines of code, pull request counts and speed are deliberately
 * absent from this file. Every figure here is a ratio over verified outcomes, so an agent that
 * produces a lot of wrong work scores worse than one that produces a little right work.
 *
 * Second rule, learned from the monitor: a metric that the ledger cannot support must say so.
 * `value` is null and `status` is 'not_measurable' with the missing evidence named, rather than
 * a zero or a flattering default. An unmeasured number printed as 0% looks identical to a failure
 * and an unmeasured number printed as 100% looks identical to success; both are lies.
 *
 * Everything below is a pure function over rows. The only I/O is `readScorecardInput`, so each
 * definition can be tested against fabricated ledgers without a database.
 */

import { query } from '../db/index.js'
import { isSuccess } from './monitor.js'

export type MetricStatus = 'measured' | 'not_measurable'

export interface Metric {
  id: string
  label: string
  /** Null when not measurable. A ratio is 0..1, money is USD, a count is a plain integer. */
  value: number | null
  unit: 'ratio' | 'usd' | 'count'
  status: MetricStatus
  numerator?: number
  denominator?: number
  /** Why it is not measurable, or what the figure is over. Always set. */
  basis: string
  /** 'thin' when the denominator is too small to call a trend. A ratio over one task is a fact, not a rate. */
  confidence?: 'thin' | 'adequate'
  /** Which direction is better, so a dashboard never has to guess. */
  better: 'higher' | 'lower'
}

export interface RunInput {
  id: string
  agent_id: string
  status: string
  spend_usd_micros: number
  created_at: string | Date
}

export interface StageEventInput {
  correlation_id: string
  stage_id: string
  event_type: 'stage.started' | 'stage.completed' | 'stage.failed' | 'stage.skipped'
  insert_seq: number
}

export interface TaskEventInput {
  correlation_id: string | null
  task_id: string | null
  event_type: 'task.delegated' | 'task.completed' | 'task.rejected'
}

export interface AlertInput {
  code: string
  severity: 'low' | 'medium' | 'high'
  acknowledged_at: string | Date | null
  created_at: string | Date
}

export interface ScorecardInput {
  runs: RunInput[]
  stageEvents: StageEventInput[]
  taskEvents: TaskEventInput[]
  alerts: AlertInput[]
  /** Run ids that are retries of an earlier failed run for the same slot or task. */
  retriedRunIds?: string[]
}

const notMeasurable = (m: Omit<Metric, 'value' | 'status'>): Metric => ({ ...m, value: null, status: 'not_measurable' })
/** Fewer than this many observations and a ratio says almost nothing about the team. */
export const MIN_SAMPLE = 5
const measured = (m: Omit<Metric, 'status'>): Metric => ({
  ...m,
  status: 'measured',
  confidence: m.denominator !== undefined && m.denominator < MIN_SAMPLE ? 'thin' : 'adequate',
})

function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null
}

/**
 * Stage rework: a stage that started more than once for one correlation id was sent back.
 * `back_to_*` failures re-run the producing stage, so a second `stage.started` is the rework.
 */
export function stageRework(events: StageEventInput[]) {
  const starts = new Map<string, number>()
  for (const e of events) {
    if (e.event_type !== 'stage.started') continue
    const key = `${e.correlation_id}::${e.stage_id}`
    starts.set(key, (starts.get(key) ?? 0) + 1)
  }
  const stages = [...starts.keys()]
  const reworked = stages.filter((k) => (starts.get(k) ?? 0) > 1)
  return { stages: stages.length, reworked: reworked.length, perStage: starts }
}

/**
 * First-pass success: of the jobs that reached the QA verify stage, how many passed it on the
 * first attempt without the build stage being run again.
 */
export function firstPass(events: StageEventInput[]) {
  const byCorr = new Map<string, StageEventInput[]>()
  for (const e of events) {
    const list = byCorr.get(e.correlation_id) ?? []
    list.push(e)
    byCorr.set(e.correlation_id, list)
  }
  let reachedVerify = 0
  let passedFirst = 0
  for (const list of byCorr.values()) {
    const ordered = [...list].sort((a, b) => a.insert_seq - b.insert_seq)
    const verifyDone = ordered.find((e) => e.stage_id === 'verify' && (e.event_type === 'stage.completed' || e.event_type === 'stage.failed'))
    if (!verifyDone) continue
    reachedVerify++
    const buildStarts = ordered.filter((e) => e.stage_id === 'build' && e.event_type === 'stage.started').length
    const verifyFailedBefore = ordered.some((e) => e.stage_id === 'verify' && e.event_type === 'stage.failed' && e.insert_seq < verifyDone.insert_seq)
    if (verifyDone.event_type === 'stage.completed' && buildStarts <= 1 && !verifyFailedBefore) passedFirst++
  }
  return { reachedVerify, passedFirst }
}

/** A run that failed and was followed by a successful run of the same agent inside the window. */
export function recovery(runs: RunInput[], windowHours = 26) {
  const byAgent = new Map<string, RunInput[]>()
  for (const r of runs) {
    const list = byAgent.get(r.agent_id) ?? []
    list.push(r)
    byAgent.set(r.agent_id, list)
  }
  let failures = 0
  let recovered = 0
  for (const list of byAgent.values()) {
    const ordered = [...list].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    ordered.forEach((r, i) => {
      if (isSuccess(r.status) || r.status === 'running') return
      failures++
      const t0 = +new Date(r.created_at)
      const later = ordered.slice(i + 1).find((n) => isSuccess(n.status) && +new Date(n.created_at) - t0 <= windowHours * 3600_000)
      if (later) recovered++
    })
  }
  return { failures, recovered }
}

export function buildScorecard(input: ScorecardInput): { metrics: Metric[]; headline: string } {
  const { runs, stageEvents, taskEvents, alerts } = input
  const metrics: Metric[] = []

  // 1. Task completion rate: accepted tasks that completed, out of tasks that were delegated.
  const delegated = taskEvents.filter((e) => e.event_type === 'task.delegated')
  const completed = taskEvents.filter((e) => e.event_type === 'task.completed')
  if (delegated.length === 0) {
    metrics.push(notMeasurable({
      id: 'task_completion', label: 'Task completion rate', unit: 'ratio', better: 'higher',
      basis: 'No task.delegated event exists in the window, so there is no denominator.',
    }))
  } else {
    const doneIds = new Set(completed.map((e) => e.task_id).filter(Boolean))
    const n = delegated.filter((e) => e.task_id && doneIds.has(e.task_id)).length
    metrics.push(measured({
      id: 'task_completion', label: 'Task completion rate', unit: 'ratio', better: 'higher',
      value: ratio(n, delegated.length), numerator: n, denominator: delegated.length,
      basis: 'Delegated tasks that recorded task.completed, over delegated tasks.',
    }))
  }

  // 2. First-pass success: needs the pipeline's verify stage to have run.
  const fp = firstPass(stageEvents)
  if (fp.reachedVerify === 0) {
    metrics.push(notMeasurable({
      id: 'first_pass_success', label: 'First-pass success', unit: 'ratio', better: 'higher',
      basis: 'No job has reached the verify stage; stage.* events are not being written for scheduled or delegated work yet.',
    }))
  } else {
    metrics.push(measured({
      id: 'first_pass_success', label: 'First-pass success', unit: 'ratio', better: 'higher',
      value: ratio(fp.passedFirst, fp.reachedVerify), numerator: fp.passedFirst, denominator: fp.reachedVerify,
      basis: 'Jobs whose verify stage passed with the build stage started once, over jobs that reached verify.',
    }))
  }

  // 3. Rework rate: stages that were started more than once.
  const rw = stageRework(stageEvents)
  if (rw.stages === 0) {
    metrics.push(notMeasurable({
      id: 'rework_rate', label: 'Rework rate', unit: 'ratio', better: 'lower',
      basis: 'No stage.started events exist, so a returned stage cannot be distinguished from a first attempt.',
    }))
  } else {
    metrics.push(measured({
      id: 'rework_rate', label: 'Rework rate', unit: 'ratio', better: 'lower',
      value: ratio(rw.reworked, rw.stages), numerator: rw.reworked, denominator: rw.stages,
      basis: 'Stages started more than once for one correlation id, over stages started.',
    }))
  }

  // 4. Budget efficiency: money spent per SUCCESSFUL run, with failed spend counted in the numerator.
  const ok = runs.filter((r) => isSuccess(r.status))
  const totalMicros = runs.reduce((s, r) => s + Number(r.spend_usd_micros || 0), 0)
  if (ok.length === 0) {
    metrics.push(notMeasurable({
      id: 'budget_efficiency', label: 'Cost per successful run', unit: 'usd', better: 'lower',
      basis: runs.length === 0 ? 'No runs in the window.' : `${runs.length} runs spent $${(totalMicros / 1e6).toFixed(6)} and none succeeded, so the cost per success is unbounded.`,
    }))
  } else {
    metrics.push(measured({
      id: 'budget_efficiency', label: 'Cost per successful run', unit: 'usd', better: 'lower',
      value: totalMicros / 1e6 / ok.length, numerator: totalMicros, denominator: ok.length,
      basis: 'ALL spend in the window, failed runs included, divided by successful runs. Failed spend is not hidden.',
    }))
  }

  // 5. Recovery rate.
  const rec = recovery(runs)
  if (rec.failures === 0) {
    metrics.push(notMeasurable({
      id: 'recovery_rate', label: 'Recovery rate', unit: 'ratio', better: 'higher',
      basis: 'No failed runs in the window, so there is nothing to recover from.',
    }))
  } else {
    metrics.push(measured({
      id: 'recovery_rate', label: 'Recovery rate', unit: 'ratio', better: 'higher',
      value: ratio(rec.recovered, rec.failures), numerator: rec.recovered, denominator: rec.failures,
      basis: 'Failed runs followed by a successful run of the same agent within 26 hours, over failed runs.',
    }))
  }

  // 6. Security quality: unresolved critical/high blockers. Zero is the target, and it is a count.
  const blockers = alerts.filter((a) => a.severity === 'high' && !a.acknowledged_at)
  metrics.push(measured({
    id: 'security_quality', label: 'Open high-severity blockers', unit: 'count', better: 'lower',
    value: blockers.length, numerator: blockers.length,
    basis: 'Every unacknowledged high alert, whatever its age, the top tier the monitor emits. Zero means none are open now, not that none were raised.',
  }))

  const m = new Map(metrics.map((x) => [x.id, x]))
  const unmeasured = metrics.filter((x) => x.status === 'not_measurable').length
  const thin = metrics.filter((x) => x.status === 'measured' && x.confidence === 'thin').length
  const headline = `${metrics.length - unmeasured} of ${metrics.length} measures are backed by the ledger; ${unmeasured} are not measurable yet` +
    `${thin ? `, and ${thin} rest on fewer than ${MIN_SAMPLE} observations` : ''}. ` +
    `${m.get('security_quality')!.value} open high-severity blockers.`
  return { metrics, headline }
}

/** Compare two windows. A trend is only claimed when both ends are measured. */
export function trend(prev: Metric, curr: Metric): 'improving' | 'worsening' | 'flat' | 'unknown' {
  if (prev.value === null || curr.value === null) return 'unknown'
  const delta = curr.value - prev.value
  if (Math.abs(delta) < 1e-9) return 'flat'
  const up = delta > 0
  return (up && curr.better === 'higher') || (!up && curr.better === 'lower') ? 'improving' : 'worsening'
}

export interface AgentScore {
  agent_id: string
  /** The denominator behind success_rate, never a score: a high count is not an achievement. */
  observations: number
  succeeded: number
  success_rate: number | null
  /** 'thin' below MIN_SAMPLE, so a one-run 100% cannot outrank a reliable agent. */
  confidence: 'thin' | 'adequate'
  spend_usd: number
  /** Cost of this agent's spend per success. Null when it never succeeded. */
  usd_per_success: number | null
}

/** Per-agent view. No volume column on purpose: how many runs an agent made is not a score. */
export function perAgent(runs: RunInput[]): AgentScore[] {
  const by = new Map<string, RunInput[]>()
  for (const r of runs) {
    const list = by.get(r.agent_id) ?? []
    list.push(r)
    by.set(r.agent_id, list)
  }
  return [...by.entries()].map(([agent_id, list]) => {
    const succeeded = list.filter((r) => isSuccess(r.status)).length
    const spend = list.reduce((s, r) => s + Number(r.spend_usd_micros || 0), 0) / 1e6
    return {
      agent_id, observations: list.length, succeeded,
      success_rate: ratio(succeeded, list.length),
      confidence: list.length < MIN_SAMPLE ? 'thin' as const : 'adequate' as const,
      spend_usd: spend,
      usd_per_success: succeeded > 0 ? spend / succeeded : null,
    }
  }).sort((a, b) => (b.success_rate ?? -1) - (a.success_rate ?? -1) || a.agent_id.localeCompare(b.agent_id))
}

export async function readScorecardInput(opts: { sinceHours: number; untilHours?: number; teamOnly?: boolean }): Promise<ScorecardInput> {
  const since = `now() - ($1 || ' hours')::interval`
  const end = `now() - ($2 || ' hours')::interval`
  const params: unknown[] = opts.untilHours ? [String(opts.sinceHours), String(opts.untilHours)] : [String(opts.sinceHours)]
  // Team scope is applied to EVERY query. Filtering only runs let unrelated agents move the
  // stage, task and alert measures while the run measures stayed team-only.
  const team = opts.teamOnly === false ? '' : `AND agent_id LIKE 'tdt\_%'`
  // An open blocker is open whatever its age, so the current window counts all unacknowledged
  // rows. The previous window is evaluated AS OF its end, or a long-lived blocker would vanish
  // from the older side and manufacture a fake improvement.
  // Its own placeholder and parameter list: reusing the window params made Postgres complain that
  // the statement had no placeholders while one value was bound.
  const alertsWhere = opts.untilHours
    ? `created_at <= now() - ($1 || ' hours')::interval AND (acknowledged_at IS NULL OR acknowledged_at > now() - ($1 || ' hours')::interval)`
    : `acknowledged_at IS NULL`
  const alertParams: unknown[] = opts.untilHours ? [String(opts.untilHours)] : []
  const [runs, stages, tasks, alerts] = await Promise.all([
    query(`SELECT id, agent_id, status, spend_usd_micros, created_at FROM agent_runs WHERE created_at > ${since} ${opts.untilHours ? `AND created_at <= ${end}` : ''} ${team} ORDER BY created_at`, params),
    query(`SELECT correlation_id, stage_id, event_type, insert_seq FROM agent_audit_events
            WHERE created_at > ${since} ${opts.untilHours ? `AND created_at <= ${end}` : ''} ${team}
              AND event_type IN ('stage.started','stage.completed','stage.failed','stage.skipped') ORDER BY insert_seq`, params),
    query(`SELECT correlation_id, task_id, event_type FROM agent_audit_events
            WHERE created_at > ${since} ${opts.untilHours ? `AND created_at <= ${end}` : ''} ${team}
              AND event_type IN ('task.delegated','task.completed','task.rejected')`, params),
    query(`SELECT code, severity, acknowledged_at, created_at FROM agent_alerts WHERE ${alertsWhere} ${team}`, alertParams),
  ])
  return {
    runs: (runs.rows as any[]).map((r) => ({ ...r, spend_usd_micros: Number(r.spend_usd_micros) })),
    stageEvents: (stages.rows as any[]).map((r) => ({ ...r, insert_seq: Number(r.insert_seq) })),
    taskEvents: tasks.rows as any[],
    alerts: alerts.rows as any[],
  }
}

export interface ScorecardReport {
  window_hours: number
  headline: string
  metrics: Array<Metric & { previous: number | null; trend: ReturnType<typeof trend> }>
  agents: AgentScore[]
  /** Spelled out so a reader never mistakes a missing pipeline for a perfect one. */
  gaps: string[]
}

/** Current window against the window of equal length before it. */
export async function scorecardReport(windowHours: number): Promise<ScorecardReport> {
  const hours = Math.min(Math.max(Math.floor(windowHours) || 24, 1), 24 * 90)
  const [curr, prev] = await Promise.all([
    readScorecardInput({ sinceHours: hours }),
    readScorecardInput({ sinceHours: hours * 2, untilHours: hours }),
  ])
  const now = buildScorecard(curr)
  const before = new Map(buildScorecard(prev).metrics.map((m) => [m.id, m]))
  const gaps: string[] = []
  for (const m of now.metrics) if (m.status === 'not_measurable') gaps.push(`${m.label}: ${m.basis}`)
  return {
    window_hours: hours,
    headline: now.headline,
    metrics: now.metrics.map((m) => ({ ...m, previous: before.get(m.id)?.value ?? null, trend: trend(before.get(m.id) ?? m, m) })),
    agents: perAgent(curr.runs),
    gaps,
  }
}
