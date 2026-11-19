/**
 * The operating specification, as code.
 *
 * team/operating-spec/MASTER-OPERATING-SPEC.md is what a person and an agent read. This module is
 * the same document reduced to the parts a program can check, so the rules stop depending on an
 * agent remembering them: a lifecycle the runner can order, an envelope the validator can test,
 * a roster the pipelines can be held against.
 *
 * Nothing here replaces existing machinery. It composes with it:
 *   - the envelope check runs the existing JSON Schema validator first, then adds the fields the
 *     schema does not carry (src/team/validate.ts stays the schema authority);
 *   - artifact kinds are read from src/agents/artifacts.ts rather than restated, so the registry
 *     cannot drift from the specification without the suite noticing;
 *   - the roster is checked against team/agents/<role>/SKILL.md, the same packs repo_read serves.
 *
 * The invariant that matters: this file may not disagree with the document, the pipelines, the
 * roster or the artifact registry. tests/operating-spec.test.ts is what enforces that.
 */
import specJson from './spec.json' with { type: 'json' }
import { validateTask } from './validate.js'
import { ARTIFACT_KINDS } from '../agents/artifacts.js'

type RoleEntry = {
  role: string
  agent: string
  pack: string
  produces: string
  creates_if_missing: boolean
  mapped_not_created?: string
  owns_lifecycle?: boolean
}

type PriorityEntry = { id: string; db_priority: string; meaning: string }

export type OperatingSpec = {
  version: string
  adopted: string
  document: string
  central_orchestrator: string
  roles: RoleEntry[]
  unmapped_roster: { agent: string; reason: string }[]
  categories: string[]
  priorities: PriorityEntry[]
  lifecycle: {
    stages: string[]
    exceptions: string[]
    terminal: string
    unsatisfied_terminals: string[]
    gates_never_skipped: string[]
    backward_move_is: string
  }
  task_status_to_stage: Record<string, string>
  status_map_note: string
  envelope: {
    fields: string[]
    aliases: Record<string, string>
    required: string[]
    recommended: string[]
    recommended_note: string
  }
  artifacts: { kinds: string[]; source: string; handoff_rule: string }
  severity: { order: string[]; blocks_release: string[]; exception_required_to_release: string }
  financial: {
    stages: string[]
    owner_agent: string
    independent_authority: string
    forbids: string[]
    reorg_rule: string
  }
  pipelines: {
    known_gaps?: { pipeline: string; stages: string[]; problem: string }[]
    required: string[]
    by_category: Record<string, string>
    planned_not_built: string[]
    planned_note: string
    stage_lifecycle: Record<string, string>
  }
  completion: { requires: string[]; partial_rule: string }
}

export const SPEC = specJson as unknown as OperatingSpec
export const SPEC_VERSION = SPEC.version
export const SPEC_DOCUMENT = SPEC.document

export const STAGES: readonly string[] = SPEC.lifecycle.stages
export const EXCEPTIONS: readonly string[] = SPEC.lifecycle.exceptions
export const GATES: readonly string[] = SPEC.lifecycle.gates_never_skipped
export const TERMINAL: string = SPEC.lifecycle.terminal

/** Every agent id the specification accounts for, mapped or explicitly set aside. */
export const SPEC_AGENTS: readonly string[] = [
  ...SPEC.roles.map((r) => r.agent),
  ...SPEC.unmapped_roster.map((u) => u.agent),
]

const BY_AGENT = new Map(SPEC.roles.map((r) => [r.agent, r]))
const BY_ROLE = new Map(SPEC.roles.map((r) => [r.role, r]))

export const roleFor = (agentId: string): RoleEntry | undefined => BY_AGENT.get(agentId)
export const agentForRole = (role: string): string | undefined => BY_ROLE.get(role)?.agent
export const packFor = (agentId: string): string | undefined => BY_AGENT.get(agentId)?.pack

export const stageIndex = (stage: string): number => STAGES.indexOf(stage)
export const isStage = (v: string): boolean => STAGES.includes(v)
export const isException = (v: string): boolean => EXCEPTIONS.includes(v)

/** The next stage in the chain, or null at the end. */
export const nextStage = (stage: string): string | null => {
  const i = stageIndex(stage)
  return i === -1 || i + 1 >= STAGES.length ? null : STAGES[i + 1]
}

export type TransitionCheck =
  | { ok: true; rework: boolean; skippedGates: string[] }
  | { ok: false; errors: string[]; skippedGates?: string[] }

/**
 * Can a task move from one lifecycle stage to another?
 *
 * Forward moves are accepted only when they do not jump mandatory QA, security or release-readiness
 * gates. Skipped gates are included in refusals so a caller cannot mistake a blocked transition for
 * permission. A backward move is REWORK. An exception state can be entered from any stage, but
 * recovery must resume before any mandatory gate that has not yet been evidenced.
 */
export function checkTransition(from: string, to: string): TransitionCheck {
  const fromIdx = stageIndex(from)
  const toIdx = stageIndex(to)
  const fromIsException = isException(from)
  const toIsException = isException(to)

  if (fromIdx === -1 && !fromIsException) return { ok: false, errors: [`unknown lifecycle stage: ${from}`] }
  if (toIdx === -1 && !toIsException) return { ok: false, errors: [`unknown lifecycle stage: ${to}`] }
  if (from === to) return { ok: true, rework: false, skippedGates: [] }

  if (toIsException) return { ok: true, rework: to === 'REWORK', skippedGates: [] }
  if (fromIsException) {
    const skippedGates = GATES.filter((g) => stageIndex(g) < toIdx)
    if (skippedGates.length) {
      return { ok: false, errors: [`cannot resume at ${to} while mandatory gates remain unproven: ${skippedGates.join(', ')}`], skippedGates }
    }
    return { ok: true, rework: from === 'REWORK', skippedGates }
  }
  if (fromIdx < toIdx) {
    const skippedGates = GATES.filter((g) => {
      const gi = stageIndex(g)
      return gi > fromIdx && gi < toIdx
    })
    if (skippedGates.length) {
      return { ok: false, errors: [`cannot skip mandatory lifecycle gates: ${skippedGates.join(', ')}`], skippedGates }
    }
    return { ok: true, rework: false, skippedGates }
  }
  return { ok: true, rework: true, skippedGates: [] }
}

/** The stored status is coarse; the lifecycle is fine. This is the honest projection between them. */
export function stageForTaskStatus(status: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(SPEC.task_status_to_stage, status) ? SPEC.task_status_to_stage[status] : undefined
}

/** P0 is the only priority whose stored equivalent is `critical`; the mapping is data, not a guess. */
export function dbPriorityFor(priorityId: string): string | undefined {
  return SPEC.priorities.find((p) => p.id === priorityId)?.db_priority
}

export function blocksRelease(severities: string[]): boolean {
  return severities.some((s) => SPEC.severity.blocks_release.includes(String(s).toLowerCase()))
}

export function artifactKindAllowed(kind: string): boolean {
  return ARTIFACT_KINDS.includes(String(kind ?? '').trim().toLowerCase() as (typeof ARTIFACT_KINDS)[number])
}

/** The artifact registry is the runtime truth; the specification must not restate it differently. */
export function artifactKindsAgree(): boolean {
  const spec = [...SPEC.artifacts.kinds].sort().join(',')
  const live = [...ARTIFACT_KINDS].sort().join(',')
  return spec === live
}

export function pipelineForCategory(category: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(SPEC.pipelines.by_category, category) ? SPEC.pipelines.by_category[category] : undefined
}

/** Lifecycle stage a pipeline stage corresponds to, so a run can be projected onto the chain. */
export function stageForPipelineStage(pipelineStageId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(SPEC.pipelines.stage_lifecycle, pipelineStageId) ? SPEC.pipelines.stage_lifecycle[pipelineStageId] : undefined
}

export type EnvelopeResult = { ok: true; warnings: string[] } | { ok: false; errors: string[] }

/**
 * Validate a task envelope: the existing schema first, then the specification's extra fields.
 *
 * The schema stays the refusal path (a malformed task is refused before money is spent). Fields the
 * specification wants but the schema does not carry are reported as warnings, because refusing a
 * live delegation over a missing correlation id would break work that is otherwise well formed.
 */
export function validateOperatingTask(task: unknown): EnvelopeResult {
  const schema = validateTask(task)
  if (!schema.ok) return { ok: false, errors: schema.errors }

  const obj = task as Record<string, unknown>
  const missing: string[] = []
  for (const field of SPEC.envelope.required) {
    const stored = SPEC.envelope.aliases[field] ?? field
    const value = obj[field] ?? obj[stored]
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0) || value === '') {
      missing.push(field)
    }
  }
  if (missing.length) {
    return { ok: false, errors: missing.map((f) => `/${f} is required by the operating specification`) }
  }

  const warnings = SPEC.envelope.recommended
    .filter((field) => {
      const stored = SPEC.envelope.aliases[field] ?? field
      return (obj[field] ?? obj[stored]) === undefined
    })
    .map((f) => `/${f} is recommended by the operating specification and was not supplied`)

  return { ok: true, warnings }
}

/**
 * Compare the specification against what is actually on disk.
 *
 * Called by the test suite with the real file lists, so an added folder or a renamed pack fails
 * loudly instead of silently drifting away from the document the team is told to follow.
 *
 * The pack slug is read out of the pack path rather than from the role name, because two roles map
 * onto identities whose folders are named after the identity (wallet -> blockchain, data ->
 * intelligence). Whether that mapping is still the right one is a judgement call; whether it is
 * still the mapping recorded in the specification is a test.
 */
export function checkRoleCoverage(packSlugs: string[], rosterAgents: string[]): string[] {
  const problems: string[] = []
  const packs = new Set(packSlugs)
  const agents = new Set(rosterAgents)
  const coveredPacks = new Set<string>()

  for (const role of SPEC.roles) {
    const slug = packSlug(role.pack)
    if (!slug) {
      problems.push(`spec role ${role.role} points at ${role.pack}, which is not a team/agents/<role>/SKILL.md path`)
      continue
    }
    coveredPacks.add(slug)
    if (!packs.has(slug)) problems.push(`spec role ${role.role} expects a pack at team/agents/${slug}/SKILL.md, which does not exist`)
    if (!agents.has(role.agent)) problems.push(`spec role ${role.role} maps to ${role.agent}, which is not a roster agent`)
  }

  for (const slug of packSlugs) {
    if (coveredPacks.has(slug)) continue
    if (SPEC.unmapped_roster.some((u) => u.agent === `tdt_${slug}`)) continue
    problems.push(`team/agents/${slug} is not accounted for in the operating specification (map it or list it under unmapped_roster)`)
  }

  for (const extra of SPEC.unmapped_roster) {
    if (!agents.has(extra.agent)) problems.push(`unmapped_roster lists ${extra.agent}, which is not a roster agent`)
  }

  const seen = new Set<string>()
  for (const role of SPEC.roles) {
    if (seen.has(role.agent)) problems.push(`two spec roles map onto ${role.agent}; one agent cannot hold two accountable roles`)
    seen.add(role.agent)
  }
  return problems
}

function packSlug(pack: string): string | null {
  const m = /^team\/agents\/([^/]+)\/SKILL\.md$/.exec(pack)
  return m ? m[1] : null
}
