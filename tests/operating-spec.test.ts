import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const PACKS_DIR = fileURLToPath(new URL('../team/agents', import.meta.url))
import {
  SPEC,
  SPEC_VERSION,
  SPEC_DOCUMENT,
  SPEC_AGENTS,
  STAGES,
  EXCEPTIONS,
  GATES,
  TERMINAL,
  roleFor,
  packFor,
  agentForRole,
  nextStage,
  stageIndex,
  checkTransition,
  stageForTaskStatus,
  dbPriorityFor,
  blocksRelease,
  artifactKindAllowed,
  artifactKindsAgree,
  pipelineForCategory,
  stageForPipelineStage,
  validateOperatingTask,
  checkRoleCoverage,
} from '../src/team/spec.js'
import { ARTIFACT_KINDS } from '../src/agents/artifacts.js'

const DOC = readFileSync(SPEC_DOCUMENT, 'utf8')
const PACK_SLUGS = readdirSync('team/agents', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
const ROSTER_AGENTS = PACK_SLUGS.map((slug) => `tdt_${slug}`)
const PIPELINES = readdirSync('team/pipelines')
  .filter((f) => f.endsWith('.pipeline.json'))
  .map((f) => JSON.parse(readFileSync(`team/pipelines/${f}`, 'utf8')))

const validTask = () => ({
  task_id: 'task_0123456789abcdef0123',
  project_id: 'thirdeye-ai',
  title: 'Give HERMES the operating specification',
  objective: 'Adopt the team operating specification as the shared contract.',
  owner: 'hermes',
  created_by: 'owner',
  status: 'in_progress',
  priority: 'high',
  acceptance_criteria: ['The document is in the repository and the suite holds it to the code.'],
  created_at: '2026-11-15T09:00:00.000Z',
  correlation_id: 'corr_0123456789abcdef',
  requester: 'owner',
  category: 'documentation',
  risk_level: 'medium',
  permission_scopes: ['repo_write'],
  budget_limit: 12000,
  out_of_scope: ['Deploying anything'],
  dependencies: [],
  output_expectations: ['report'],
})

test('the machine contract and the document are the same specification', () => {
  assert.equal(SPEC_VERSION, '1.0')
  assert.ok(DOC.length > 20000, 'the document should hold the whole directive, not a summary')

  // Every enumerated rule in the contract has to appear in the prose the team is told to read,
  // otherwise one of the two has been edited alone.
  for (const stage of STAGES) assert.ok(DOC.includes(stage), `lifecycle stage ${stage} is missing from the document`)
  for (const state of EXCEPTIONS) assert.ok(DOC.includes(state), `exception state ${state} is missing from the document`)
  for (const category of SPEC.categories) assert.ok(DOC.includes(category), `category ${category} is missing from the document`)
  for (const priority of SPEC.priorities) assert.ok(DOC.includes(priority.id), `priority ${priority.id} is missing from the document`)
  for (const stage of SPEC.financial.stages) assert.ok(DOC.includes(stage), `financial stage ${stage} is missing from the document`)
  for (const kind of SPEC.artifacts.kinds) assert.ok(DOC.includes(kind), `artifact kind ${kind} is missing from the document`)
  for (const severity of SPEC.severity.order) assert.ok(DOC.toLowerCase().includes(severity), `severity ${severity} is missing from the document`)

  assert.ok(DOC.includes('Never invent a test result'), 'the document must keep the line that forbids invented evidence')
  assert.ok(DOC.includes('Do not create duplicate orchestrators'), 'the document must keep the no-duplicate-systems rule')
})

test('every specified role maps onto a real agent and a real capability pack', () => {
  const problems = checkRoleCoverage(PACK_SLUGS, ROSTER_AGENTS)
  assert.deepEqual(problems, [])

  for (const role of SPEC.roles) {
    assert.equal(roleFor(role.agent)?.role, role.role)
    assert.equal(agentForRole(role.role), role.agent)
    assert.equal(packFor(role.agent), role.pack)
    assert.ok(artifactKindAllowed(role.produces), `${role.role} produces ${role.produces}, which is not a registry kind`)
    const pack = readFileSync(role.pack, 'utf8')
    assert.ok(pack.length > 200, `${role.pack} looks like a stub`)
  }
})

test('the roster is fully accounted for, including the identities the specification does not name', () => {
  assert.equal(SPEC_AGENTS.length, new Set(SPEC_AGENTS).size, 'an agent is listed twice')
  assert.equal(SPEC.roles.length, 11, 'the specification names eleven roles besides the orchestrator')
  assert.ok(SPEC.unmapped_roster.some((u) => u.agent === 'tdt_agent-engineer'), 'agent-engineer must stay listed rather than dropped')
  for (const extra of SPEC.unmapped_roster) assert.ok(extra.reason.length > 20, `${extra.agent} needs a reason, not a shrug`)
})

test('the specification names the orchestrator it is built around, and it is a live agent', () => {
  assert.equal(SPEC.central_orchestrator, 'tdt_hermes')
  assert.equal(roleFor(SPEC.central_orchestrator)?.owns_lifecycle, true)
})

test('every pipeline is mapped from a category and every pipeline stage projects onto the lifecycle', () => {
  for (const required of SPEC.pipelines.required) {
    assert.ok(PIPELINES.some((p) => p.id === required), `pipeline ${required} is required by the specification and missing`)
  }
  for (const pipeline of PIPELINES) {
    assert.ok(SPEC.pipelines.required.includes(pipeline.id), `pipeline ${pipeline.id} exists but the specification does not account for it`)
    for (const stage of pipeline.stages) {
      const mapped = stageForPipelineStage(stage.id)
      assert.ok(mapped, `pipeline ${pipeline.id}/${stage.id} has no lifecycle projection`)
      assert.ok(STAGES.includes(String(mapped)), `pipeline ${pipeline.id}/${stage.id} projects onto unknown stage ${mapped}`)
    }
    for (const stage of pipeline.stages) {
      assert.ok(SPEC_AGENTS.includes(stage.owner), `pipeline ${pipeline.id}/${stage.id} owned by ${stage.owner}, which the specification does not account for`)
    }
  }
  for (const category of SPEC.categories) {
    const target = pipelineForCategory(category)
    assert.ok(target, `category ${category} routes to no pipeline`)
    assert.ok(PIPELINES.some((p) => p.id === target), `category ${category} routes to missing pipeline ${target}`)
  }
})

test('nothing reaches production without the owner, and that rule lives in the specification too', () => {
  for (const pipeline of PIPELINES) {
    for (const stage of pipeline.stages) {
      if (stage.environment !== 'production') continue
      assert.equal(stage.approval, 'owner', `${pipeline.id}/${stage.id} promotes without owner approval`)
    }
  }
  assert.ok(DOC.includes('Stop affected work') || DOC.includes('owner authorization for production release'))
})

test('the artifact kinds in the specification are the ones the registry actually accepts', () => {
  assert.equal(artifactKindsAgree(), true)
  assert.deepEqual([...SPEC.artifacts.kinds].sort(), [...ARTIFACT_KINDS].sort())
})

test('the lifecycle is ordered, unambiguous and ends in exactly one terminal state', () => {
  assert.equal(STAGES.length, 15)
  assert.equal(new Set(STAGES).size, STAGES.length, 'duplicate lifecycle stage')
  assert.equal(STAGES[STAGES.length - 1], TERMINAL)
  assert.equal(EXCEPTIONS.filter((e) => STAGES.includes(e)).length, 0, 'an exception state cannot also be a chain stage')
  assert.equal(new Set(EXCEPTIONS).size, EXCEPTIONS.length, 'duplicate exception state')
  assert.equal(nextStage(TERMINAL), null)
  assert.equal(stageIndex('RECEIVED'), 0)
  assert.equal(nextStage('RECEIVED'), 'VALIDATED')

  // The eight stored statuses all project onto the chain; none is left without a home.
  const statuses = ['queued', 'assigned', 'in_progress', 'blocked', 'review', 'completed', 'failed', 'cancelled']
  for (const status of statuses) {
    const stage = stageForTaskStatus(status)
    assert.ok(stage, `stored status ${status} projects onto nothing`)
    // Every projection must be a real lifecycle stage or a real exception: 'QUEUED_INTAKE' used to be
    // exempted here, which is why a status that checkTransition rejects looked legal.
    assert.ok(STAGES.includes(stage) || EXCEPTIONS.includes(stage), `${status} projects onto unknown ${stage}`)
  }
  assert.equal(stageForTaskStatus('completed'), TERMINAL)
  assert.equal(stageForTaskStatus('failed'), 'REWORK')
})

test('transitions allow forward progress, flag skipped gates, and never hide a backward move', () => {
  const forward = checkTransition('IN_PROGRESS', 'REVIEW_READY')
  assert.equal(forward.ok, true)
  assert.equal(forward.ok && forward.rework, false)
  assert.deepEqual(forward.ok && forward.skippedGates, [])

  // Jumping straight from build to release skips QA, security and readiness. The specification calls
  // those gates unskippable, so the move is refused and the gates are named as the reason.
  const leap = checkTransition('IN_PROGRESS', 'RELEASED')
  assert.equal(leap.ok, false)
  assert.match(!leap.ok ? leap.errors.join(' ') : '', /QA_VERIFICATION/)
  assert.match(!leap.ok ? leap.errors.join(' ') : '', /SECURITY_REVIEW/)
  assert.match(!leap.ok ? leap.errors.join(' ') : '', /RELEASE_READY/)

  const backward = checkTransition('QA_VERIFICATION', 'IN_PROGRESS')
  assert.equal(backward.ok, true)
  assert.equal(backward.ok && backward.rework, true)

  assert.equal(checkTransition('IN_PROGRESS', 'BLOCKED').ok, true)
  assert.equal(checkTransition('BLOCKED', 'IN_PROGRESS').ok, true)
  assert.equal(checkTransition('IN_PROGRESS', 'INVENTED').ok, false)
  assert.equal(checkTransition('INVENTED', 'IN_PROGRESS').ok, false)
  assert.deepEqual([...GATES], ['QA_VERIFICATION', 'SECURITY_REVIEW', 'RELEASE_READY'])
})

test('a mandatory gate cannot be jumped, and an exception cannot re-enter past one', () => {
  // Every forward move that would cross a gate is refused, not merely annotated.
  assert.equal(checkTransition('ASSIGNED', 'RELEASED').ok, false)
  assert.equal(checkTransition('QA_VERIFICATION', 'RELEASED').ok, false)
  // Exiting an exception into a stage beyond a gate is the same jump by another route.
  assert.equal(checkTransition('BLOCKED', 'RELEASED').ok, false)
  assert.equal(checkTransition('REWORK', 'COMPLETED').ok, false)
  // Exiting an exception before the gates still works, because nothing is crossed.
  assert.equal(checkTransition('BLOCKED', 'IN_PROGRESS').ok, true)
  assert.equal(checkTransition('REWORK', 'PLANNED').ok, true)
})

test('unknown stages are rejected even when the move is to itself, and lookups cannot reach the prototype', () => {
  assert.equal(checkTransition('INVENTED', 'INVENTED').ok, false)
  assert.equal(stageForTaskStatus('constructor'), undefined)
  assert.equal(stageForTaskStatus('toString'), undefined)
  assert.equal(pipelineForCategory('constructor'), undefined)
  assert.equal(artifactKindAllowed('  REPORT  '), true)
  assert.equal(artifactKindAllowed('Report'), true)
  assert.equal(artifactKindAllowed('invented'), false)
})

test('a task envelope is refused when a specified field is missing, and warned when an optional one is', () => {
  const ok = validateOperatingTask(validTask())
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok && ok.warnings, [])

  const noCriteria = { ...validTask(), acceptance_criteria: [] }
  const refused = validateOperatingTask(noCriteria)
  assert.equal(refused.ok, false)
  assert.ok(!refused.ok && refused.errors.some((e) => e.includes('acceptance_criteria')), 'the refusal must name the field')

  const thin = { ...validTask() }
  delete (thin as any).correlation_id
  delete (thin as any).category
  delete (thin as any).permission_scopes
  delete (thin as any).output_expectations
  const warned = validateOperatingTask(thin)
  assert.equal(warned.ok, true)
  assert.ok(warned.ok && warned.warnings.length === 4, 'four recommended fields were dropped, four warnings expected')
  assert.ok(warned.ok && warned.warnings.some((w) => w.includes('correlation_id')))
  assert.ok(warned.ok && warned.warnings.some((w) => w.includes('output_artifact')), 'a missing output artifact must be reported')

  const malformed = validateOperatingTask({ ...validTask(), priority: 'urgent' })
  assert.equal(malformed.ok, false, 'the schema still refuses a priority outside its enum')
})

test('the envelope covers every field the specification requires a task to carry', () => {
  const schema = JSON.parse(readFileSync('src/team/schemas/task.schema.json', 'utf8'))
  for (const field of SPEC.envelope.fields) {
    const stored = SPEC.envelope.aliases[field] ?? field
    assert.ok(schema.properties[stored], `envelope field ${field} is not representable in the task schema`)
  }
  for (const field of SPEC.envelope.required) {
    assert.ok(SPEC.envelope.fields.includes(field), `required field ${field} is not part of the envelope`)
  }
  assert.equal(SPEC.envelope.recommended.includes('correlation_id'), true)
})

test('priorities, severities and categories keep their stated meaning', () => {
  assert.deepEqual(SPEC.priorities.map((p) => p.id), ['P0', 'P1', 'P2', 'P3'])
  assert.deepEqual(SPEC.priorities.map((p) => p.db_priority), ['critical', 'high', 'normal', 'low'])
  assert.equal(dbPriorityFor('P0'), 'critical')
  assert.equal(SPEC.categories.length, 13)
  assert.equal(new Set(SPEC.categories).size, 13)

  assert.equal(blocksRelease(['high']), true)
  assert.equal(blocksRelease(['critical']), true)
  assert.equal(blocksRelease(['medium', 'low', 'informational']), false)
  assert.equal(blocksRelease([]), false)
  assert.equal(artifactKindAllowed('test_report'), true)
  assert.equal(artifactKindAllowed('screenshot'), false)
})

test('financial work has its own lifecycle and cannot grant itself authority', () => {
  assert.equal(SPEC.financial.stages.length, 9)
  assert.equal(SPEC.financial.stages[0], 'TRANSACTION_INTENT')
  assert.equal(SPEC.financial.stages[8], 'RECONCILIATION')
  assert.equal(SPEC.financial.owner_agent, 'tdt_blockchain')
  assert.ok(SPEC.financial.independent_authority.includes('payments-policy'))
  assert.ok(SPEC.financial.forbids.length >= 6)
  assert.ok(SPEC.financial.reorg_rule.toLowerCase().includes('never auto-reverse'))
})

test('completion requires evidence, and an unmet criterion can never be completed', () => {
  assert.ok(SPEC.completion.requires.length >= 9)
  assert.ok(SPEC.completion.requires.some((r) => r.includes('actual recorded results')))
  assert.ok(SPEC.completion.partial_rule.includes('partially complete'))
})

test('pipeline outputs the registry cannot store are recorded as gaps, not tolerated silently', () => {
  const offending: string[] = []
  for (const pipeline of PIPELINES) {
    for (const stage of pipeline.stages) {
      if (!ARTIFACT_KINDS.includes(stage.produces)) offending.push(stage.produces)
    }
  }
  const declared = (SPEC.pipelines.known_gaps ?? []).flatMap((g: any) => g.stages).sort()
  assert.deepEqual(offending.sort(), declared as string[],
    'a stage now produces something unstoreable, or a declared gap was fixed: update the specification either way')
  for (const gap of SPEC.pipelines.known_gaps ?? []) {
    assert.ok(String((gap as any).problem).length > 40, 'a known gap needs an explanation, not a label')
  }
})

test('the shared operating block is identical in every agent pack', () => {
  // These sentences are copied verbatim into all twelve packs. Nothing checked the copies, so
  // editing one pack drifted the rest silently while the text claimed the suite would catch it.
  const canonical = [
    '- Every task carries one accountable owner, an acceptance condition and a stated output artifact. If the owner or the acceptance condition is missing, the task is not ready and you say so instead of starting; a task with no output artifact cannot be closed. On the delegated path `src/agents/runner.ts` does not populate the artifact yet, so the machine envelope reports it as a warning rather than a refusal.',
    '- A specialist\'s report is a claim, not proof. Nobody closes a task on a child\'s success message alone.',
    '- Artifact ids travel between agents; summaries are the index, not the evidence. Use the artifact registry rather than pasting truncated text.',
    'risk policy may allow skipping',
    'not the lifecycle stages themselves',
  ]
  const packs = readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
  assert.ok(packs.length >= 12, `expected at least twelve packs, found ${packs.length}`)
  for (const pack of packs) {
    const text = readFileSync(join(PACKS_DIR, pack, 'SKILL.md'), 'utf8')
    for (const line of canonical) {
      assert.ok(text.includes(line), `${pack}/SKILL.md is missing the canonical text: ${line.slice(0, 60)}`)
    }
  }
})
