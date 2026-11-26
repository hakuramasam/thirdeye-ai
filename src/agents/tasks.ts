/**
 * Durable task spine (PH2-004).
 *
 * Before this module a delegated job was prose: the parent wrote "QA: verify the patch" into its
 * report, the child ran once, and nothing durable recorded who owned the work, whether it was the
 * first attempt, or why the last attempt failed. So the team could not be asked "how often does a
 * stage succeed first time" — the answer did not exist anywhere, and a rework looked exactly like
 * a fresh job.
 *
 * The rule this module adds: a job is a row, and the row is the state machine. A task is created
 * once, claimed by exactly one owner, and then completed or failed. Claim is a single atomic
 * `UPDATE ... WHERE status IN ('queued','blocked')`, so two agents racing for the same job cannot
 * both win — the loser gets null and must look for other work. Because the row outlives the run
 * that touched it, attempt > 1 counts rework and completed-with-attempt-1 counts first-pass
 * success, which is the measurement the whole table exists for.
 *
 * What is deliberately not here: no implicit retry and no silent reopen. Completing a task that is
 * not in progress is refused, and failing a task that already reached a terminal state is refused,
 * so a late or duplicated call cannot rewrite the record of what happened.
 */

import { randomBytes } from 'node:crypto'
import { query, one } from '../db/index.js'

/** Every state the database CHECK constraint allows. Kept in one place so callers stop guessing. */
export const TASK_STATUSES = [
  'queued',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** States a task never leaves. A failure or a completion after this point would rewrite history. */
const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'cancelled']

export type AgentTaskRow = {
  id: string
  correlation_id: string
  pipeline_id: string | null
  stage_id: string | null
  title: string
  instruction: string
  owner_agent_id: string | null
  status: TaskStatus
  priority: string | null
  parent_task_id: string | null
  attempt: number
  artifacts: unknown
  result: unknown
  error: string | null
  created_at: string
  updated_at: string | null
  started_at: string | null
  completed_at: string | null
}

export type CreateTaskInput = {
  /** The chain the job belongs to. Inherited by delegated runs, so a task is never orphaned. */
  correlationId: string
  title: string
  instruction: string
  pipelineId?: string | null
  stageId?: string | null
  /** Usually null: the claim sets the owner, so create cannot pre-assign a job to two agents. */
  ownerAgentId?: string | null
  priority?: string | null
  parentTaskId?: string | null
  /** Artifact addresses already known at creation. Normally empty; completion fills it in. */
  artifacts?: unknown[]
  /** Caller-supplied address, for idempotent replays. Generated when absent. */
  id?: string
}

/**
 * A refusal the caller can branch on. `code` is stable; the message is for a human reading logs.
 * Distinct from a database error: this means the request was understood and is not allowed.
 */
export class TaskConflictError extends Error {
  code: 'invalid_input' | 'not_found' | 'not_in_progress' | 'terminal'
  status: string | null

  constructor(code: TaskConflictError['code'], message: string, status: string | null = null) {
    super(message)
    this.name = 'TaskConflictError'
    this.code = code
    this.status = status
  }
}

export function newTaskId(): string {
  return `tsk_${randomBytes(12).toString('hex')}`
}

function required(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new TaskConflictError('invalid_input', `a task needs ${field}`)
  return text
}

/**
 * Create one task in the only state a new task may start in: queued, attempt 1, no owner.
 *
 * Owner and attempt are deliberately not inputs. A job that begins owned is a job nobody claimed,
 * and a job that begins at attempt 2 is a rework whose first attempt was never recorded.
 */
export async function createTask(input: CreateTaskInput): Promise<AgentTaskRow> {
  const correlationId = required(input.correlationId, 'a correlation_id')
  const title = required(input.title, 'a title')
  const instruction = required(input.instruction, 'an instruction')
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newTaskId()

  const row = (await one(
    `INSERT INTO agent_tasks
       (id, correlation_id, pipeline_id, stage_id, title, instruction, owner_agent_id,
        status, priority, parent_task_id, attempt, artifacts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,1,$10::jsonb)
     RETURNING *`,
    [
      id,
      correlationId,
      input.pipelineId ?? null,
      input.stageId ?? null,
      title,
      instruction,
      input.ownerAgentId ?? null,
      input.priority ?? null,
      input.parentTaskId ?? null,
      JSON.stringify(input.artifacts ?? []),
    ]
  )) as AgentTaskRow | null

  if (!row) throw new TaskConflictError('not_found', `task ${id} was not created`)
  return row
}

/**
 * Claim a task for one agent, or lose.
 *
 * One statement does the whole decision: the row only matches while it is queued or blocked, so
 * Postgres serialises the two UPDATEs and the second sees status = 'in_progress' and matches
 * nothing. That is why this returns null rather than throwing — losing a race is ordinary, and the
 * caller should go look for another job. started_at keeps the first claim, so a task that was
 * blocked and reclaimed still reports when work actually began.
 */
export async function claimTask(id: string, ownerAgentId: string): Promise<AgentTaskRow | null> {
  const taskId = required(id, 'an id')
  const owner = required(ownerAgentId, 'an owner agent id')
  return (await one(
    `UPDATE agent_tasks
        SET status = 'in_progress',
            owner_agent_id = $2,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1 AND status IN ('queued','blocked')
      RETURNING *`,
    [taskId, owner]
  )) as AgentTaskRow | null
}

/**
 * Complete a task that is in progress.
 *
 * The WHERE clause is the guard, not a read-then-write check: a task that is queued, already
 * completed, or failed cannot be marked complete by a late caller. A refusal distinguishes a
 * missing row from a row in the wrong state, because those are different bugs.
 */
export async function completeTask(id: string, result: unknown): Promise<AgentTaskRow> {
  const taskId = required(id, 'an id')
  const row = (await one(
    `UPDATE agent_tasks
        SET status = 'completed',
            result = $2::jsonb,
            completed_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'in_progress'
      RETURNING *`,
    [taskId, JSON.stringify(result ?? null)]
  )) as AgentTaskRow | null
  if (row) return row
  throw await refusal(taskId, 'not_in_progress', 'complete')
}

/**
 * Record a failed attempt and increment the attempt counter.
 *
 * The increment is what makes rework measurable: the next attempt of this task is attempt 2, so a
 * pipeline that keeps sending work back is visible in the data instead of only in the report. A
 * failed task is not directly claimable — claim accepts queued and blocked — so a retry has to
 * move it back to 'blocked' or 'queued' explicitly, which keeps "who asked for the retry" in the
 * audit trail rather than hidden inside a retry loop.
 */
export async function failTask(id: string, error: string): Promise<AgentTaskRow> {
  const taskId = required(id, 'an id')
  const reason = String(error ?? '').trim() || 'no reason recorded'
  const row = (await one(
    `UPDATE agent_tasks
        SET status = 'failed',
            error = $2,
            attempt = attempt + 1,
            updated_at = now()
      WHERE id = $1 AND status NOT IN ('completed','cancelled')
      RETURNING *`,
    [taskId, reason]
  )) as AgentTaskRow | null
  if (row) return row
  throw await refusal(taskId, 'terminal', 'fail')
}

/** Every task in one pipeline, oldest first, so a pipeline reads as the sequence it was. */
export async function listTasksByPipeline(pipelineId: string): Promise<AgentTaskRow[]> {
  const pipeline = required(pipelineId, 'a pipeline id')
  const res = await query(
    `SELECT * FROM agent_tasks WHERE pipeline_id = $1 ORDER BY created_at, id`,
    [pipeline]
  )
  return res.rows as AgentTaskRow[]
}

/**
 * Explain a refusal. The losing branch runs only when nothing matched, so the extra read costs
 * nothing on the happy path and turns "no row" into either not_found or the actual state.
 */
async function refusal(taskId: string, code: 'not_in_progress' | 'terminal', verb: string): Promise<TaskConflictError> {
  const row = (await one(`SELECT status FROM agent_tasks WHERE id = $1`, [taskId])) as { status: string } | null
  if (!row) return new TaskConflictError('not_found', `no task ${taskId} to ${verb}`, null)
  const status = String(row.status)
  if (code === 'terminal') {
    return new TaskConflictError('terminal', `task ${taskId} is ${status}; a terminal task cannot ${verb}`, status)
  }
  return new TaskConflictError('not_in_progress', `task ${taskId} is ${status}, not in_progress; refusing to ${verb}`, status)
}

/** True when the state can never change again. Exposed so callers do not re-derive the list. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status as TaskStatus)
}
