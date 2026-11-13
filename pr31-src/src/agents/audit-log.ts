/**
 * Append-only execution audit (Phase 2, PH2-001).
 *
 * Why this exists: `agent_run_events` records tool calls well enough for the monitor to judge a
 * single run, but it cannot answer "what happened to this piece of work, in order, across every
 * agent that touched it". There is no correlation id, no parent run, no task or stage, and no
 * record of an authorization decision. That gap is the reason the team cannot be given more
 * autonomy: nobody can reconstruct a decision after the fact.
 *
 * Three rules hold this together.
 *
 * 1. One correlation id per root execution, inherited by every delegated run. A run id stays
 *    unique per execution, so a chain reads as corr -> run -> child run -> tool calls.
 * 2. Append-only. The application never updates or deletes an audit row, and the table refuses
 *    both at the database level, so a bug or an agent cannot rewrite history.
 * 3. Fail closed where authority moves. Most audit writes are best effort: losing a note about a
 *    tool call degrades observability, so it must not kill a run the owner already paid for. But
 *    a handoff, a grant or a permission change is different: if that event cannot be persisted,
 *    the operation it describes must not happen. Those types throw `AuditUnavailableError` and
 *    the caller refuses.
 *
 * What is deliberately not here: secrets. Every string is scrubbed for credential shapes and
 * every object is redacted by key before it reaches the database.
 */

import { randomUUID } from 'node:crypto'
import { query } from '../db/index.js'
import { newId } from '../lib/env.js'
import { traceIdFrom } from '../telemetry/langfuse.js'

export type ActorType = 'agent' | 'system' | 'owner' | 'scheduler'

export type AuditEventType =
  | 'run.created'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'task.created'
  | 'task.delegated'
  | 'task.accepted'
  | 'task.completed'
  | 'task.rejected'
  | 'stage.started'
  | 'stage.completed'
  | 'stage.failed'
  | 'stage.skipped'
  | 'artifact.created'
  | 'artifact.updated'
  | 'artifact.read'
  | 'tool.invoked'
  | 'tool.denied'
  | 'permission.changed'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.rejected'

export const AUDIT_EVENT_TYPES: AuditEventType[] = [
  'run.created',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'task.created',
  'task.delegated',
  'task.accepted',
  'task.completed',
  'task.rejected',
  'stage.started',
  'stage.completed',
  'stage.failed',
  'stage.skipped',
  'artifact.created',
  'artifact.updated',
  'artifact.read',
  'tool.invoked',
  'tool.denied',
  'permission.changed',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
]

/**
 * Events that move authority or money. A run with no note about a tool call is a gap in the
 * story; a handoff with no note about it is a hole in the ledger of who could do what.
 *
 * `tool.denied` is intentionally NOT in this set. A denial has already failed closed: nothing
 * ran. Refusing to continue because the denial could not be written would punish the caller for
 * a report integrity problem, so it is recorded best effort and reported by the monitor instead.
 */
export const CRITICAL_EVENT_TYPES: AuditEventType[] = [
  'task.delegated',
  'permission.changed',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
]

export type AuditStatus = 'started' | 'succeeded' | 'failed' | 'denied' | 'skipped' | 'pending'

export type AuditContext = {
  correlationId: string
  runId?: string | null
  parentRunId?: string | null
  taskId?: string | null
  agentId?: string | null
  agentRole?: string | null
  pipelineId?: string | null
  stageId?: string | null
  actorType?: ActorType
  authorizationContext?: Record<string, unknown> | null
}

export type AuditEvent = AuditContext & {
  eventType: AuditEventType
  status?: AuditStatus | null
  toolName?: string | null
  artifactIds?: string[]
  errorCode?: string | null
  errorSummary?: string | null
  metadata?: Record<string, unknown> | null
}

export type AuditRow = {
  id: string
  insert_seq: number | string
  event_id: string
  correlation_id: string
  trace_id: string | null
  run_id: string | null
  parent_run_id: string | null
  task_id: string | null
  agent_id: string | null
  agent_role: string | null
  pipeline_id: string | null
  stage_id: string | null
  event_type: string
  actor_type: string
  authorization_context: Record<string, unknown>
  tool_name: string | null
  artifact_ids: string[]
  status: string | null
  error_code: string | null
  error_summary: string | null
  metadata: Record<string, unknown>
  created_at: string | Date
}

/** The audit log could not accept an event that authority depends on. Callers must refuse. */
export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable'
  readonly eventType: AuditEventType
  constructor(eventType: AuditEventType, cause?: unknown) {
    super(`Audit log unavailable for ${eventType}; the operation was refused: ${String((cause as any)?.message ?? cause ?? '')}`.slice(0, 500))
    this.name = 'AuditUnavailableError'
    this.eventType = eventType
  }
}

export function newCorrelationId(): string {
  return `corr_${randomUUID()}`
}

export function isCriticalEvent(eventType: AuditEventType): boolean {
  return CRITICAL_EVENT_TYPES.includes(eventType)
}

/** The root context for an execution that nobody handed a correlation id to. */
export function rootContext(runId: string, extra: Omit<AuditContext, 'correlationId' | 'runId'> = {}): AuditContext {
  return { ...extra, correlationId: newCorrelationId(), runId }
}

const SECRET_KEY = /^(password|passwd|secret|token|access_token|refresh_token|api_?key|private_?key|authorization|cookie|mnemonic|seed|seed_phrase)$/i

/** Strip anything credential-shaped before it can reach a row a human will read. */
export function scrubAuditText(value: string, max = 400): string {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(?<=bearer\s)[A-Za-z0-9._-]{10,}/gi, '***')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh***')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key redacted]')
    .slice(0, max)
}

/** Redact by key and by shape, to a bounded depth. Never throws: a weird payload still gets audited. */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return scrubAuditText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForAudit(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactForAudit(v, depth + 1)
    }
    return out
  }
  return scrubAuditText(String(value))
}

type Writer = (row: Record<string, unknown>) => Promise<unknown>

const defaultWriter: Writer = async (row) => {
  await query(
    `INSERT INTO agent_audit_events (
       id, event_id, correlation_id, trace_id, run_id, parent_run_id, task_id, agent_id, agent_role,
       pipeline_id, stage_id, event_type, actor_type, authorization_context, tool_name, artifact_ids,
       status, error_code, error_summary, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      row.id,
      row.event_id,
      row.correlation_id,
      row.trace_id,
      row.run_id,
      row.parent_run_id,
      row.task_id,
      row.agent_id,
      row.agent_role,
      row.pipeline_id,
      row.stage_id,
      row.event_type,
      row.actor_type,
      JSON.stringify(row.authorization_context ?? {}),
      row.tool_name,
      JSON.stringify(row.artifact_ids ?? []),
      row.status,
      row.error_code,
      row.error_summary,
      JSON.stringify(row.metadata ?? {}),
    ]
  )
}

/**
 * Persist one audit event.
 *
 * Returns the event id. For a critical event the write is allowed to throw: the caller then
 * refuses the operation it was about to perform. For everything else a failure is absorbed and
 * `null` comes back, because a note about a tool call is not worth failing paid work over.
 */
export async function createAuditEvent(
  ev: AuditEvent,
  opts: { writer?: Writer } = {}
): Promise<string | null> {
  if (!AUDIT_EVENT_TYPES.includes(ev.eventType)) {
    throw new Error(`Unknown audit event type: ${String(ev.eventType)}`)
  }
  if (!ev.correlationId) throw new Error('An audit event needs a correlation id')

  const row: Record<string, unknown> = {
    id: newId(),
    event_id: `evt_${randomUUID()}`,
    correlation_id: ev.correlationId,
    trace_id: ev.runId ? traceIdFrom(ev.runId) : null,
    run_id: ev.runId ?? null,
    parent_run_id: ev.parentRunId ?? null,
    task_id: ev.taskId ?? null,
    agent_id: ev.agentId ?? null,
    agent_role: ev.agentRole ?? null,
    pipeline_id: ev.pipelineId ?? null,
    stage_id: ev.stageId ?? null,
    event_type: ev.eventType,
    actor_type: ev.actorType ?? 'agent',
    authorization_context: redactForAudit(ev.authorizationContext ?? {}) as Record<string, unknown>,
    tool_name: ev.toolName ? scrubAuditText(ev.toolName, 120) : null,
    artifact_ids: (ev.artifactIds ?? []).map((a) => scrubAuditText(String(a), 120)),
    status: ev.status ?? null,
    error_code: ev.errorCode ? scrubAuditText(ev.errorCode, 80) : null,
    error_summary: ev.errorSummary ? scrubAuditText(ev.errorSummary, 500) : null,
    metadata: redactForAudit(ev.metadata ?? {}) as Record<string, unknown>,
  }

  try {
    await (opts.writer ?? defaultWriter)(row)
    return String(row.event_id)
  } catch (e) {
    if (process.env.AUDIT_DEBUG) console.error('[audit] insert failed:', (e as any)?.message ?? e)
    if (isCriticalEvent(ev.eventType)) throw new AuditUnavailableError(ev.eventType, e)
    return null
  }
}

/** Read the audit trail back. One of these three keys is normally enough to reconstruct a story. */
export async function readAuditEvents(
  filter: { correlationId?: string; runId?: string; parentRunId?: string; taskId?: string; eventType?: AuditEventType; limit?: number } = {}
): Promise<AuditRow[]> {
  const where: string[] = []
  const params: any[] = []
  const add = (sql: string, value: any) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)) }
  if (filter.correlationId) add('correlation_id = ?', filter.correlationId)
  if (filter.runId) add('run_id = ?', filter.runId)
  if (filter.parentRunId) add('parent_run_id = ?', filter.parentRunId)
  if (filter.taskId) add('task_id = ?', filter.taskId)
  if (filter.eventType) add('event_type = ?', filter.eventType)
  const limit = Math.min(Math.max(Number(filter.limit ?? 200), 1), 1000)
  const sql = `SELECT * FROM agent_audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY insert_seq ASC LIMIT ${limit}`
  const res = await query(sql, params)
  return res.rows as AuditRow[]
}

// --- Typed recorders -------------------------------------------------------------------------
// Thin, named wrappers so a call site reads as what happened instead of as a row shape.

export function recordRunEvent(
  ctx: AuditContext,
  eventType: 'run.created' | 'run.started',
  extra: Partial<AuditEvent> = {}
): Promise<string | null> {
  return createAuditEvent({ ...ctx, ...extra, eventType, status: extra.status ?? 'started' })
}

export function recordRunCompleted(
  ctx: AuditContext,
  extra: { toolCalls?: number; spendMicros?: number; metadata?: Record<string, unknown> } = {}
): Promise<string | null> {
  return createAuditEvent({
    ...ctx,
    eventType: 'run.completed',
    status: 'succeeded',
    metadata: { tool_calls: extra.toolCalls ?? 0, spend_usd_micros: extra.spendMicros ?? 0, ...(extra.metadata ?? {}) },
  })
}

export function recordRunFailed(
  ctx: AuditContext,
  extra: { errorCode?: string; errorSummary?: string | null; toolCalls?: number; spendMicros?: number; eventType?: 'run.failed' | 'run.cancelled' } = {}
): Promise<string | null> {
  return createAuditEvent({
    ...ctx,
    eventType: extra.eventType ?? 'run.failed',
    status: extra.eventType === 'run.cancelled' ? 'skipped' : 'failed',
    errorCode: extra.errorCode ?? 'run_failed',
    errorSummary: extra.errorSummary ?? null,
    metadata: { tool_calls: extra.toolCalls ?? 0, spend_usd_micros: extra.spendMicros ?? 0 },
  })
}

/** A handoff. Critical: if this cannot be written, the delegation must not happen. */
export function recordTaskDelegated(
  ctx: AuditContext,
  extra: { taskId: string; toAgentId?: string | null; metadata?: Record<string, unknown> } = { taskId: '' }
): Promise<string | null> {
  return createAuditEvent({
    ...ctx,
    taskId: extra.taskId ?? ctx.taskId ?? null,
    eventType: 'task.delegated',
    status: 'started',
    metadata: { to_agent_id: extra.toAgentId ?? null, ...(extra.metadata ?? {}) },
  })
}

export function recordTaskOutcome(
  ctx: AuditContext,
  outcome: 'task.completed' | 'task.rejected',
  extra: { taskId?: string | null; metadata?: Record<string, unknown> } = {}
): Promise<string | null> {
  return createAuditEvent({
    ...ctx,
    taskId: extra.taskId ?? ctx.taskId ?? null,
    eventType: outcome,
    status: outcome === 'task.completed' ? 'succeeded' : 'failed',
    metadata: extra.metadata ?? {},
  })
}

export function recordStageTransition(
  ctx: AuditContext,
  extra: {
    stageId: string
    eventType: 'stage.started' | 'stage.completed' | 'stage.failed' | 'stage.skipped'
    reason?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<string | null> {
  const status: AuditStatus =
    extra.eventType === 'stage.started'
      ? 'started'
      : extra.eventType === 'stage.skipped'
        ? 'skipped'
        : extra.eventType === 'stage.failed'
          ? 'failed'
          : 'succeeded'
  return createAuditEvent({
    ...ctx,
    stageId: extra.stageId,
    eventType: extra.eventType,
    status,
    metadata: { reason: extra.reason ?? null, ...(extra.metadata ?? {}) },
  })
}

/**
 * The stage history of one correlation id, folded into counts.
 *
 * Read from the trail rather than stored in a cursor table: the append-only log is already the
 * truth about what ran, so a second source of ordering could disagree with it. Deliberately
 * narrow — stage events for this correlation only, no run or tool rows.
 */
export async function readStageLedger(correlationId: string): Promise<import('./pipeline.js').StageLedger> {
  const { ledgerFrom } = await import('./pipeline.js')
  const res = await query(
    `SELECT stage_id, event_type FROM agent_audit_events
      WHERE correlation_id = $1 AND stage_id IS NOT NULL
        AND event_type IN ('stage.started','stage.completed','stage.failed','stage.skipped')
      ORDER BY insert_seq ASC
      LIMIT 1000`,
    [correlationId]
  )
  return ledgerFrom(res.rows as any[])
}

export function recordToolInvocation(
  ctx: AuditContext,
  extra: { tool: string; ok: boolean; refused?: boolean; argsExcerpt?: string | null; resultExcerpt?: string | null; metadata?: Record<string, unknown> }
): Promise<string | null> {
  const denied = Boolean(extra.refused)
  return createAuditEvent({
    ...ctx,
    eventType: denied ? 'tool.denied' : 'tool.invoked',
    status: denied ? 'denied' : extra.ok ? 'succeeded' : 'failed',
    toolName: extra.tool,
    errorSummary: extra.ok ? null : scrubAuditText(String(extra.resultExcerpt ?? ''), 300),
    metadata: {
      args_excerpt: scrubAuditText(String(extra.argsExcerpt ?? ''), 300),
      result_excerpt: scrubAuditText(String(extra.resultExcerpt ?? ''), 300),
      ...(extra.metadata ?? {}),
    },
  })
}

/** An authorization decision, allowed or refused. `permission.changed` is critical. */
export function recordAuthorizationDecision(
  ctx: AuditContext,
  extra: { allowed: boolean; tool?: string | null; reason: string; critical?: boolean; metadata?: Record<string, unknown> }
): Promise<string | null> {
  return createAuditEvent({
    ...ctx,
    eventType: extra.critical ? 'permission.changed' : extra.allowed ? 'approval.granted' : 'tool.denied',
    status: extra.allowed ? 'succeeded' : 'denied',
    toolName: extra.tool ?? null,
    authorizationContext: { allowed: extra.allowed, reason: extra.reason },
    metadata: extra.metadata ?? {},
  })
}

export function recordArtifactEvent(
  ctx: AuditContext,
  extra: { action: 'created' | 'updated' | 'read'; artifactId: string; version?: number | null; metadata?: Record<string, unknown> }
): Promise<string | null> {
  return createAuditEvent({
    ...ctx,
    eventType: (`artifact.${extra.action}` as AuditEventType),
    status: 'succeeded',
    artifactIds: [extra.artifactId],
    metadata: { version: extra.version ?? null, ...(extra.metadata ?? {}) },
  })
}
