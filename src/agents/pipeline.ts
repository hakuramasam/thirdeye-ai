/**
 * Deterministic pipeline order (PH2-002).
 *
 * Why this exists: the team's pipelines are declared as documents in `team/pipelines/*.json` —
 * stage ids, an owner per stage, the artifact each stage produces, which artifacts it consumes,
 * and what to do when it fails. Nothing enforced any of it. A run declared `pipeline_id` and
 * `stage_id` purely for the audit trail, and the orchestrator model decided for itself who to
 * call, in whatever order it liked, as many times as it liked. So "design before build" and
 * "verify before release" were prose in a JSON file, and a sprint could not be reconstructed as
 * a sequence of stages because no sequence existed.
 *
 * The rule this module adds: when a caller declares a pipeline, the next stage is not a
 * suggestion the model makes. It is the only move the pipeline allows. Everything here is a
 * pure function over the declared pipeline and the stage events already in the audit trail, so
 * the decision is reproducible from the trail alone — no extra state, no hidden cursor.
 *
 * What is deliberately not here: no autonomy grant. A pipeline decides *order and ownership*;
 * it never decides that a stage may skip its owner approval. `approval: "owner"` stages still
 * need the owner, and this module refuses to advance past a stage whose dependencies are unmet
 * rather than assuming the paperwork happened.
 */

import featurePipeline from '../../team/pipelines/feature.pipeline.json' with { type: 'json' }
import bugfixPipeline from '../../team/pipelines/bugfix.pipeline.json' with { type: 'json' }
import incidentPipeline from '../../team/pipelines/incident.pipeline.json' with { type: 'json' }

export type StageApproval = 'none' | 'hermes' | 'owner'

/** Every on_failure value the declared pipelines use. Unknown values fail validation. */
export type StageOnFailure =
  | 'stop'
  | 'rollback'
  | 'warn'
  | 'escalate_owner'
  | 'back_to_scope'
  | 'back_to_build'
  | 'back_to_patch'

export type PipelineStage = {
  id: string
  owner: string
  purpose?: string
  gate?: string
  produces?: string
  consumes?: string[]
  environment?: 'none' | 'preview' | 'production'
  approval?: StageApproval
  on_failure?: StageOnFailure
}

export type PipelineDoc = {
  id: string
  version?: number
  summary?: string
  trigger?: string
  stages: PipelineStage[]
}

const APPROVALS: StageApproval[] = ['none', 'hermes', 'owner']
const ON_FAILURE: StageOnFailure[] = [
  'stop',
  'rollback',
  'warn',
  'escalate_owner',
  'back_to_scope',
  'back_to_build',
  'back_to_patch',
]

/** The declared pipelines, imported rather than read from disk: a serverless bundle has no cwd. */
export const PIPELINES: Record<string, PipelineDoc> = {
  [featurePipeline.id]: featurePipeline as PipelineDoc,
  [bugfixPipeline.id]: bugfixPipeline as PipelineDoc,
  [incidentPipeline.id]: incidentPipeline as PipelineDoc,
}

export function getPipeline(pipelineId: string | null | undefined): PipelineDoc | null {
  if (!pipelineId) return null
  return PIPELINES[String(pipelineId).toLowerCase()] ?? null
}

export function pipelineIds(): string[] {
  return Object.keys(PIPELINES).sort()
}

/**
 * Static checks a declared pipeline must pass. Run by the tests, and by `planNextStage` on the
 * doc it is about to reason over, so a malformed pipeline refuses instead of ordering stages
 * nobody can satisfy.
 */
export function validatePipeline(doc: PipelineDoc): string[] {
  const problems: string[] = []
  if (!doc || typeof doc !== 'object') return ['pipeline is not an object']
  if (!doc.id) problems.push('pipeline has no id')
  if (!Array.isArray(doc.stages) || doc.stages.length === 0) {
    problems.push(`${doc?.id ?? '?'} has no stages`)
    return problems
  }

  const seen = new Set<string>()
  const producedBy = new Map<string, number>()

  doc.stages.forEach((stage, index) => {
    const where = `${doc.id}/${stage.id ?? `#${index}`}`
    if (!stage.id) problems.push(`${where} has no id`)
    else if (!/^[a-z][a-z0-9_]*$/.test(stage.id)) problems.push(`${where} id must be lowercase snake_case`)
    if (stage.id && seen.has(stage.id)) problems.push(`${where} id is declared twice`)
    if (stage.id) seen.add(stage.id)
    if (!stage.owner) problems.push(`${where} has no owner`)
    if (!stage.gate) problems.push(`${where} has no gate, so nobody can say when it is done`)
    if (stage.approval !== undefined && !APPROVALS.includes(stage.approval)) {
      problems.push(`${where} has unknown approval "${stage.approval}"`)
    }
    if (stage.on_failure !== undefined && !ON_FAILURE.includes(stage.on_failure)) {
      problems.push(`${where} has unknown on_failure "${stage.on_failure}"`)
    }
    if (stage.environment === 'production' && stage.approval !== 'owner') {
      problems.push(`${where} reaches production without owner approval`)
    }
    if (stage.produces) {
      if (producedBy.has(stage.produces)) {
        problems.push(`${where} produces "${stage.produces}", already produced by stage ${producedBy.get(stage.produces)}`)
      } else {
        producedBy.set(stage.produces, index)
      }
    }
  })

  // Ordering is the point of this module: a stage may only consume an artifact that an EARLIER
  // stage produces. A forward or missing dependency would let the order quietly stop being a
  // sequence, which is exactly the failure this file exists to prevent.
  doc.stages.forEach((stage, index) => {
    for (const need of stage.consumes ?? []) {
      const from = producedBy.get(need)
      if (from === undefined) problems.push(`${doc.id}/${stage.id} consumes "${need}", which no stage produces`)
      else if (from >= index) problems.push(`${doc.id}/${stage.id} consumes "${need}" from its own or a later stage`)
    }
  })

  return problems
}

/** One stage's history, derived from the append-only trail. */
export type StageState = { started: number; completed: number; failed: number; skipped: number }
export type StageLedger = Record<string, StageState>

export type StageEventLike = { stageId?: string | null; stage_id?: string | null; eventType?: string; event_type?: string }

const ZERO: StageState = { started: 0, completed: 0, failed: 0, skipped: 0 }

export function emptyLedger(): StageLedger {
  return {}
}

/** Fold stage events into per-stage counts. Anything unrelated is ignored, not guessed at. */
export function ledgerFrom(events: StageEventLike[]): StageLedger {
  const ledger: StageLedger = {}
  for (const e of events) {
    const id = e.stageId ?? e.stage_id
    const type = e.eventType ?? e.event_type
    if (!id || !type) continue
    const row = ledger[id] ?? { ...ZERO }
    if (type === 'stage.started') row.started++
    else if (type === 'stage.completed') row.completed++
    else if (type === 'stage.failed') row.failed++
    else if (type === 'stage.skipped') row.skipped++
    else continue
    ledger[id] = row
  }
  return ledger
}

/** A stage is settled once it has completed once or was explicitly skipped. */
export function isSettled(state: StageState | undefined): boolean {
  return Boolean(state && state.completed + state.skipped > 0)
}

/**
 * Settled is not the same as delivered: a skipped stage holds its place in the order but
 * produced nothing, so an artifact it was supposed to hand on is still missing.
 */
export function isDelivered(state: StageState | undefined): boolean {
  return Boolean(state && state.completed > 0)
}

export type StageRefusalCode =
  | 'pipeline_unknown'
  | 'pipeline_invalid'
  | 'pipeline_complete'
  | 'stage_in_flight'
  | 'stage_exhausted'
  | 'pipeline_stopped'
  | 'dependency_unmet'

export type StagePlan =
  | { ok: true; stage: PipelineStage; index: number; attempt: number }
  | { ok: false; code: StageRefusalCode; message: string }

export const MAX_STAGE_ATTEMPTS = 2

/**
 * The single next move, or a refusal. Read top to bottom:
 *  1. an unknown or malformed pipeline refuses everything;
 *  2. a stage that has started but not settled is in flight, so a second delegation would run
 *     the same work twice — refused, which is the idempotency guard;
 *  3. stages settle in declared order; the first unsettled stage is the candidate;
 *  4. a stage that already burned its attempts, or whose on_failure is `stop`, is a wall, not a
 *     retry;
 *  5. a candidate whose consumed artifacts were never produced (its producer was skipped) is
 *     refused, because the work would rest on an assumption;
 *  6. all stages settled means the pipeline is complete and the model must stop delegating.
 */
export function planNextStage(
  doc: PipelineDoc | null,
  ledger: StageLedger,
  opts: { maxAttempts?: number } = {}
): StagePlan {
  if (!doc) return { ok: false, code: 'pipeline_unknown', message: 'no pipeline is declared under that id' }
  const problems = validatePipeline(doc)
  if (problems.length) {
    return { ok: false, code: 'pipeline_invalid', message: `pipeline ${doc.id} is invalid: ${problems.slice(0, 3).join('; ')}` }
  }
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_STAGE_ATTEMPTS)

  for (const [index, stage] of doc.stages.entries()) {
    const state = ledger[stage.id]
    if (isSettled(state)) continue

    const started = state?.started ?? 0
    const completed = state?.completed ?? 0
    const failed = state?.failed ?? 0
    const inFlight = started - completed - failed
    if (inFlight > 0) {
      return {
        ok: false,
        code: 'stage_in_flight',
        message: `stage "${stage.id}" is already running; wait for that report instead of starting it twice`,
      }
    }
    if (failed >= maxAttempts) {
      return {
        ok: false,
        code: 'stage_exhausted',
        message: `stage "${stage.id}" has failed ${failed} times, its limit; escalate instead of retrying`,
      }
    }
    if (failed > 0 && stage.on_failure === 'stop') {
      return {
        ok: false,
        code: 'pipeline_stopped',
        message: `stage "${stage.id}" failed and its on_failure is stop, so the pipeline cannot continue`,
      }
    }
    const unmet = (stage.consumes ?? []).filter((need) => {
      const producer = doc.stages.find((s) => s.produces === need)
      return !producer || !isDelivered(ledger[producer.id])
    })
    if (unmet.length) {
      return {
        ok: false,
        code: 'dependency_unmet',
        message: `stage "${stage.id}" needs ${unmet.join(', ')}, which no completed stage produced`,
      }
    }
    return { ok: true, stage, index, attempt: failed + 1 }
  }

  return { ok: false, code: 'pipeline_complete', message: `pipeline ${doc.id} is complete; report instead of delegating` }
}

/** Pure convenience wrapper used by the runner: resolve the doc then plan the next move. */
export function planForPipeline(
  pipelineId: string | null | undefined,
  ledger: StageLedger,
  opts: { maxAttempts?: number } = {}
): StagePlan {
  return planNextStage(getPipeline(pipelineId), ledger, opts)
}

/** Ordered stage ids, for messages and tests. */
export function stageOrder(pipelineId: string): string[] {
  return getPipeline(pipelineId)?.stages.map((s) => s.id) ?? []
}
