/**
 * Job resolution as an executable queue (PH2-005).
 *
 * Why this exists: `team/workflows/job-resolution.workflow.json` described how a FEATURE job is
 * resolved — intake, success definition, design, build, test, challenge, release readiness,
 * release, accept — and nothing in `src/` imported it. The document was prose that happened to be
 * valid JSON, so the sequence could be followed by an attentive agent or ignored by a careless
 * one, and either way no durable record existed that stage 5 ran before stage 7.
 *
 * The rule this module adds: the document is the queue. Each declared step becomes one
 * `agent_tasks` row, owned by the step's declared owner, and the next row is created from the
 * workflow's own order — `advanceJob` accepts no target stage, so a caller cannot ask to skip
 * ahead. Completing a later stage's row while an earlier stage is unfinished is refused, which
 * means the only way a job reaches `accept_close` is through every stage before it.
 *
 * What is deliberately not here: no autonomy grant and no parallel fan-out. The document marks
 * `build` as parallel across `tdt_blockchain`, `tdt_backend` and `tdt_frontend`, but it declares
 * one owner per step and no per-contributor subtask shape, so this module creates one row owned by
 * `tdt_backend` and records the contributors in that row's instruction. Serialising the parallel
 * build is a real limitation of the document's shape, not a claim that build is sequential.
 */

import jobResolutionWorkflow from '../../team/workflows/job-resolution.workflow.json' with { type: 'json' }

import { query, one } from '../db/index.js'
import { createTask, claimTask, completeTask, type AgentTaskRow } from './tasks.js'

/** One declared step of the workflow. Only the fields the queue actually uses are typed. */
export type JobStage = {
  n: number
  id: string
  owner: string
  title: string
  does?: string
  gate?: string
  produces?: string
  consumes?: string[]
  example?: string
  parallel_with?: string[]
  contributors?: string[]
  money_boundary?: string
}

export type JobWorkflow = {
  id: string
  version?: number
  summary?: string
  steps: JobStage[]
  rules?: Record<string, string>
}

const STAGE_ID_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * Static checks a walkable workflow must pass: unique stage ids, an owner on every stage, and a
 * declared order that is present and complete. Run at load time below, and exported so the tests
 * can prove each refusal fires rather than trusting that the shipped file happens to be valid.
 */
export function validateJobWorkflow(doc: unknown): string[] {
  const problems: string[] = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['workflow is not an object']

  const workflow = doc as Partial<JobWorkflow> & { steps?: unknown }
  if (!workflow.id) problems.push('workflow has no id')

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    problems.push(`${workflow.id ?? '?'} declares no steps, so there is no order to walk`)
    return problems
  }

  const seen = new Set<string>()
  workflow.steps.forEach((raw, index) => {
    const step = raw as Partial<JobStage> | null
    const where = `${workflow.id ?? '?'}/${step?.id ?? `#${index + 1}`}`
    if (!step || typeof step !== 'object') {
      problems.push(`${where} is not an object`)
      return
    }
    if (!step.id) problems.push(`${where} has no id`)
    else if (!STAGE_ID_PATTERN.test(step.id)) problems.push(`${where} id must be lowercase snake_case`)
    else if (seen.has(step.id)) problems.push(`${where} id is declared twice, so a row could not say which stage it belongs to`)
    if (step.id) seen.add(step.id)

    if (typeof step.owner !== 'string' || !step.owner.trim()) {
      problems.push(`${where} names no owner, so nobody can be held to it`)
    }
    if (typeof step.title !== 'string' || !step.title.trim()) problems.push(`${where} has no title`)

    if (!Number.isInteger(step.n) || (step.n as number) < 1) {
      problems.push(`${where} declares no position (n), so the order is implied rather than declared`)
    } else if (step.n !== index + 1) {
      problems.push(`${where} declares n=${step.n} at position ${index + 1}; the declared order must be 1..N in array order`)
    }
  })

  return problems
}

/**
 * Load-time validation. A malformed workflow throws here rather than producing a queue that
 * silently walks the wrong stages, because a module that imports this file is about to rely on it.
 */
function loadWorkflow(raw: unknown): JobWorkflow {
  const problems = validateJobWorkflow(raw)
  if (problems.length) {
    throw new Error(
      `team/workflows/job-resolution.workflow.json is not a walkable queue: ${problems.join('; ')}`
    )
  }
  return raw as JobWorkflow
}

/** The parsed workflow. Imported, not read from disk: a serverless bundle has no cwd. */
export const JOB_RESOLUTION_WORKFLOW: JobWorkflow = loadWorkflow(jobResolutionWorkflow)

/** The `pipeline_id` every row of this queue carries. */
export const JOB_RESOLUTION_PIPELINE_ID = JOB_RESOLUTION_WORKFLOW.id

const STAGES: readonly JobStage[] = JOB_RESOLUTION_WORKFLOW.steps

export type StageOrderErrorCode =
  | 'task_not_found'
  | 'not_job_resolution'
  | 'stage_unknown'
  | 'stage_out_of_order'
  | 'job_complete'
  | 'claim_lost'
  | 'not_in_progress'
  | 'walk_runaway'

/**
 * A refusal the caller can branch on. Separate from `TaskConflictError` because these are
 * ordering refusals about a job, not state refusals about a single row.
 */
export class StageOrderError extends Error {
  code: StageOrderErrorCode

  constructor(code: StageOrderErrorCode, message: string) {
    super(message)
    this.name = 'StageOrderError'
    this.code = code
  }
}

/** Every stage, in declared order. A copy, so a caller cannot reorder the queue by mutation. */
export function jobStages(): JobStage[] {
  return [...STAGES]
}

export function jobStageIds(): string[] {
  return STAGES.map((stage) => stage.id)
}

export function stageIndex(stageId: string): number {
  return STAGES.findIndex((stage) => stage.id === stageId)
}

export function getJobStage(stageId: string | null | undefined): JobStage | null {
  if (!stageId) return null
  const index = stageIndex(String(stageId))
  return index === -1 ? null : STAGES[index]
}

/**
 * The one move the workflow allows after `currentStageId`, or null at the end.
 *
 * This is the whole anti-skip mechanism: the next stage is a function of the current stage, never
 * an argument. An id the workflow does not declare is refused instead of guessed at.
 */
export function nextStageId(currentStageId: string): string | null {
  const index = stageIndex(currentStageId)
  if (index === -1) {
    throw new StageOrderError('stage_unknown', `"${currentStageId}" is not a stage of ${JOB_RESOLUTION_PIPELINE_ID}`)
  }
  return index + 1 < STAGES.length ? STAGES[index + 1].id : null
}

export function nextStage(currentStageId: string): JobStage | null {
  const id = nextStageId(currentStageId)
  return id ? getJobStage(id) : null
}

export type OpenJobInput = {
  /** The chain the job belongs to. Every stage row inherits it, so the job reads as one sequence. */
  correlationId: string
  /** What the job is, in one line. Written into every stage instruction. */
  title: string
  /** Optional extra context appended to the first stage's instruction. */
  instruction?: string
  priority?: string | null
}

export type AdvanceResult = {
  completed: AgentTaskRow
  stage: JobStage
  next: { task: AgentTaskRow; stage: JobStage } | null
}

export type WalkResult = {
  correlationId: string
  stages: string[]
  rows: AgentTaskRow[]
  completed: boolean
}

function instructionFor(stage: JobStage, input: OpenJobInput): string {
  const parts = [`Job: ${input.title}.`, `Stage ${stage.n}/${STAGES.length} "${stage.id}" — ${stage.title}.`, `Owner: ${stage.owner}.`]
  if (stage.does) parts.push(stage.does)
  if (stage.gate) parts.push(`Gate: ${stage.gate}`)
  if (stage.contributors?.length) parts.push(`Contributors (declared parallel): ${stage.contributors.join(', ')}.`)
  if (input.instruction && stage.n === 1) parts.push(input.instruction)
  return parts.join(' ')
}

/** Every row of one job, in declared stage order rather than insertion order. */
export async function readJob(correlationId: string): Promise<AgentTaskRow[]> {
  const res = await query(
    `SELECT * FROM agent_tasks WHERE correlation_id = $1 AND pipeline_id = $2`,
    [correlationId, JOB_RESOLUTION_PIPELINE_ID]
  )
  return (res.rows as AgentTaskRow[]).sort((a, b) => stageIndex(String(a.stage_id)) - stageIndex(String(b.stage_id)))
}

/**
 * The job's frontier: the first declared stage that has no completed row. A stage whose row
 * failed is the frontier, which is how `failure_returns` reaches the producing step. Null means
 * every stage is complete.
 */
export async function frontierStage(correlationId: string): Promise<{ stage: JobStage; row: AgentTaskRow | null } | null> {
  const rows = await readJob(correlationId)
  const byStage = new Map(rows.map((row) => [String(row.stage_id), row]))
  for (const stage of STAGES) {
    const row = byStage.get(stage.id) ?? null
    if (!row || row.status !== 'completed') return { stage, row }
  }
  return null
}

/** Create the first stage's row. The job exists from here, and only stage 1 can be claimed. */
export async function openJob(input: OpenJobInput): Promise<{ task: AgentTaskRow; stage: JobStage }> {
  const first = STAGES[0]
  const task = await createTask({
    correlationId: input.correlationId,
    pipelineId: JOB_RESOLUTION_PIPELINE_ID,
    stageId: first.id,
    title: `${first.title} (${first.id})`,
    instruction: instructionFor(first, input),
    priority: input.priority ?? null,
  })
  return { task, stage: first }
}

/**
 * Advance a job by exactly one stage: claim the row for its declared owner, complete it with the
 * output, and create the row for the stage that follows.
 *
 * There is no `stageId` parameter on purpose. The next row is derived from this row's stage, and
 * a row whose stage is not the job's frontier is refused, so neither a caller nor a model can
 * jump to `release` because it feels finished.
 */
export async function advanceJob(taskId: string, output?: unknown): Promise<AdvanceResult> {
  const row = (await one(`SELECT * FROM agent_tasks WHERE id = $1`, [taskId])) as AgentTaskRow | null
  if (!row) throw new StageOrderError('task_not_found', `no task ${taskId}`)
  if (row.pipeline_id !== JOB_RESOLUTION_PIPELINE_ID) {
    throw new StageOrderError('not_job_resolution', `task ${taskId} belongs to pipeline "${row.pipeline_id}", not ${JOB_RESOLUTION_PIPELINE_ID}`)
  }

  const stage = getJobStage(row.stage_id)
  if (!stage) {
    throw new StageOrderError('stage_unknown', `task ${taskId} names stage "${row.stage_id}", which the workflow does not declare`)
  }

  const frontier = await frontierStage(row.correlation_id)
  if (!frontier) {
    throw new StageOrderError('job_complete', `job ${row.correlation_id} has already completed every stage`)
  }
  if (frontier.stage.id !== stage.id) {
    throw new StageOrderError(
      'stage_out_of_order',
      `stage "${stage.id}" is not the job's frontier ("${frontier.stage.id}" is unfinished); stages run in declared order and the next one is derived, never chosen`
    )
  }

  let current = row
  if (current.status === 'queued' || current.status === 'blocked') {
    const claimed = await claimTask(current.id, stage.owner)
    if (!claimed) {
      throw new StageOrderError('claim_lost', `task ${current.id} was claimed by another worker while this call advanced the job`)
    }
    current = claimed
  } else if (current.status !== 'in_progress') {
    throw new StageOrderError('not_in_progress', `task ${current.id} is ${current.status}; only a queued, blocked or in_progress stage can advance`)
  }

  const completed = await completeTask(current.id, {
    stage: stage.id,
    owner: stage.owner,
    output: output ?? null,
  })

  const following = nextStage(stage.id)
  if (!following) return { completed, stage, next: null }

  const nextTask = await createTask({
    correlationId: row.correlation_id,
    pipelineId: JOB_RESOLUTION_PIPELINE_ID,
    stageId: following.id,
    title: `${following.title} (${following.id})`,
    instruction: instructionFor(following, { correlationId: row.correlation_id, title: `continuation of ${row.correlation_id}` }),
    priority: row.priority,
    parentTaskId: row.id,
  })

  return { completed, stage, next: { task: nextTask, stage: following } }
}

/**
 * Drive a job from intake to `accept_close`, one stage at a time, handing each stage to `run`.
 *
 * The loop has no stage cursor of its own: it always advances the row it was just given, so the
 * only sequence it can produce is the workflow's. The guard exists to turn a programming error
 * into a refusal instead of an unbounded loop.
 */
export async function walkJob(input: OpenJobInput, run: (stage: JobStage) => unknown | Promise<unknown>): Promise<WalkResult> {
  const opened = await openJob(input)
  const stages: string[] = [opened.stage.id]
  const rows: AgentTaskRow[] = [opened.task]

  let cursor = opened.task
  for (;;) {
    if (stages.length > STAGES.length) {
      throw new StageOrderError('walk_runaway', `job ${input.correlationId} walked more than ${STAGES.length} stages`)
    }
    const stage = getJobStage(cursor.stage_id)
    if (!stage) throw new StageOrderError('stage_unknown', `task ${cursor.id} names unknown stage "${cursor.stage_id}"`)

    const step = await advanceJob(cursor.id, await run(stage))
    rows[rows.length - 1] = step.completed
    if (!step.next) return { correlationId: input.correlationId, stages, rows, completed: true }

    stages.push(step.next.stage.id)
    rows.push(step.next.task)
    cursor = step.next.task
  }
}
