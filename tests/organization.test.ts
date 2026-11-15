import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const ORG = JSON.parse(readFileSync('team/organization.json', 'utf8'))
const units = ORG.units as any[]
const byId = new Map(units.map((u) => [u.id, u]))
const ROSTER = [
  'tdt_hermes','tdt_architect','tdt_sentinel','tdt_backend','tdt_frontend','tdt_blockchain',
  'tdt_intelligence','tdt_devops','tdt_agent-engineer','tdt_product','tdt_qa','tdt_docs',
]
const pipelines = readdirSync('team/pipelines').filter((f) => f.endsWith('.pipeline.json')).map((f) => (
  { file: f, doc: JSON.parse(readFileSync(`team/pipelines/${f}`, 'utf8')) }
))

test('the chart covers every live agent exactly once', () => {
  assert.equal(units.length, ROSTER.length, 'one entry per roster agent')
  assert.deepEqual([...byId.keys()].sort(), [...ROSTER].sort())
})

test('there is exactly one orchestrator and every other unit reports to it', () => {
  const roots = units.filter((u) => u.reports_to === null)
  assert.equal(roots.length, 1, 'a team with two heads has none')
  assert.equal(roots[0].id, ORG.orchestrator)
  assert.equal(roots[0].id, 'tdt_hermes')
  for (const u of units) {
    if (u.id === ORG.orchestrator) continue
    assert.equal(u.reports_to, ORG.orchestrator, `${u.id} must report to the orchestrator`)
  }
})

test('every unit states one mandate, its deliverables and who owns the next step', () => {
  for (const u of units) {
    assert.ok(u.name && u.name.length > 3, `${u.id} needs a name`)
    assert.ok(u.mandate && u.mandate.length >= 20, `${u.id} needs a real mandate`)
    assert.ok(Array.isArray(u.must_deliver) && u.must_deliver.length >= 3, `${u.id} needs at least three deliverables`)
    assert.ok(Array.isArray(u.handoff_to) && u.handoff_to.length >= 1, `${u.id} must name its next owner`)
    for (const next of u.handoff_to) assert.ok(byId.has(next), `${u.id} hands off to unknown ${next}`)
  }
})

test('a unit only claims paths that exist, and keeps a skill pack on disk', () => {
  for (const u of units) {
    assert.ok(Array.isArray(u.owns_paths) && u.owns_paths.length >= 1, `${u.id} must own something`)
    for (const p of u.owns_paths) assert.ok(existsSync(p), `${u.id} claims missing path ${p}`)
    const slug = u.id.replace(/^tdt_/, '')
    assert.ok(existsSync(`team/agents/${slug}/SKILL.md`), `${u.id} has no skill pack at team/agents/${slug}`)
  }
})

test('the recommended chart role names all resolve to a real unit', () => {
  const chart = ORG.recommended_structure_map
  const required = ['hermes','product','architect','backend','frontend','wallet_finance','data_intelligence','qa','sentinel','devops','docs']
  for (const role of required) assert.ok(chart[role], `recommended role ${role} is unmapped`)
  for (const [role, id] of Object.entries(chart)) assert.ok(byId.has(String(id)), `${role} maps to unknown unit ${id}`)
  assert.match(byId.get(chart.frontend).name, /Frontend/)
  assert.match(byId.get(chart.wallet_finance).name, /Wallet & Finance/)
  assert.match(byId.get(chart.data_intelligence).name, /Data Intelligence/)
  assert.equal(new Set(Object.values(chart)).size, Object.keys(chart).length, 'two chart roles share one unit without saying so')
})

test('the five enforcement services are code, not an agent', () => {
  const svc = ORG.policy_services as any[]
  assert.equal(svc.length, 5)
  const expected = ['transaction_authorization','identity_permissions','budget_enforcement','audit_integrity','production_release']
  assert.deepEqual(svc.map((s) => s.id).sort(), expected.sort())
  for (const s of svc) {
    assert.equal(s.owner, 'code', `${s.id} must be enforced by code`)
    assert.ok(existsSync(s.enforced_in), `${s.id} points at missing ${s.enforced_in}`)
    assert.equal(byId.has(s.id), false, `${s.id} must not be delegated to an agent`)
  }
})

test('the builder is never the verifier, the reviewer or the acceptor', () => {
  for (const { file, doc } of pipelines) {
    const build = doc.stages.find((s: any) => s.produces === 'pull_request')
    const verify = doc.stages.find((s: any) => s.produces === 'test_report')
    const review = doc.stages.find((s: any) => s.produces === 'review')
    assert.ok(build, `${file} has no stage that produces a pull_request`)
    assert.ok(verify, `${file} has no independent test stage`)
    assert.notEqual(verify.owner, build.owner, `${file}: the unit that built also verifies`)
    if (review) assert.notEqual(review.owner, build.owner, `${file}: the unit that built also reviews`)
    const closure = doc.stages.find((s: any) => s.produces === 'closure')
    if (closure) assert.notEqual(closure.owner, build.owner, `${file}: the unit that built also accepts`)
    assert.equal(byId.get('tdt_qa').independent_verification, true)
    assert.equal(byId.get('tdt_sentinel').independent_verification, true)
  }
})

test('every pipeline stage owner exists in the chart', () => {
  for (const { file, doc } of pipelines) {
    for (const s of doc.stages) assert.ok(byId.has(s.owner), `${file}/${s.id} owned by unknown ${s.owner}`)
  }
})

test('the shared system states what is built and what is not', () => {
  const { tasks, artifacts, verification } = ORG.shared_system
  assert.ok(existsSync(artifacts.implementation), 'artifact store must exist')
  assert.ok(existsSync(tasks.schema), 'task schema must exist')
  assert.ok(existsSync(tasks.validator), 'task validator must exist')
  assert.match(tasks.status, /not yet/, 'an unfinished task system must say so rather than imply it works')
  assert.match(artifacts.status, /implemented/)
  assert.ok(verification.rule.includes('never the unit that accepts'))
})

const WF = JSON.parse(readFileSync('team/workflows/job-resolution.workflow.json', 'utf8'))
const steps = WF.steps as any[]

test('job resolution has nine steps in order and every step has an owner in the chart', () => {
  assert.equal(steps.length, 9)
  assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (const s of steps) {
    assert.ok(byId.has(s.owner), `step ${s.n} owned by unknown ${s.owner}`)
    for (const c of s.contributors ?? []) assert.ok(byId.has(c), `step ${s.n} names unknown contributor ${c}`)
    assert.ok(s.gate && s.gate.length > 30, `step ${s.n} needs a real gate`)
  }
})

test('job resolution opens and closes with the orchestrator', () => {
  assert.equal(steps[0].owner, 'tdt_hermes')
  assert.equal(steps[8].owner, 'tdt_hermes')
  assert.equal(steps[0].id, 'intake')
  assert.equal(steps[8].id, 'accept_close')
})

test('every artifact a step consumes was produced by an earlier step', () => {
  const made = new Set<string>()
  for (const s of steps) {
    for (const c of s.consumes) assert.ok(made.has(c), `step ${s.n} (${s.id}) consumes ${c} before anything produced it`)
    made.add(s.produces)
  }
})

test('the builder, tester, reviewer and acceptor are four different units', () => {
  const owner = (id: string) => steps.find((s) => s.id === id).owner
  const four = [owner('build'), owner('test'), owner('challenge'), owner('accept_close')]
  assert.equal(new Set(four).size, 4, `build/test/challenge/accept must be distinct, got ${four.join(',')}`)
  const builders = new Set(steps.find((s) => s.id === 'build').contributors)
  for (const id of ['test', 'challenge', 'accept_close']) {
    assert.equal(builders.has(owner(id)), false, `${id} is owned by a unit that also builds`)
  }
})

test('parallel work is declared only where the contract exists first', () => {
  const build = steps.find((s) => s.id === 'build')
  const design = steps.find((s) => s.id === 'design')
  assert.ok(steps.indexOf(design) < steps.indexOf(build), 'the API contract must precede parallel build')
  assert.ok(build.parallel_with.length >= 1)
  for (const p of build.parallel_with) assert.ok(build.contributors.includes(p), `${p} runs in parallel but is not a contributor`)
  assert.match(design.gate, /API contract/)
})

test('the money boundary and the escalation rule are written down', () => {
  assert.match(steps.find((s) => s.id === 'build').money_boundary, /owner/)
  assert.match(WF.rules.escalation, /Money/)
  assert.match(WF.rules.no_self_acceptance, /never/)
})

test('the example job follows the feature pipeline and names a real pipeline file', () => {
  assert.ok(existsSync(WF.example_job.pipeline))
  assert.equal(JSON.parse(readFileSync(WF.example_job.pipeline, 'utf8')).id, WF.example_job.classified_as)
})

test('the feature pipeline contains every job-resolution step that is a pipeline stage', () => {
  const feature = pipelines.find((p) => p.doc.id === 'feature')!.doc.stages as any[]
  const produced = new Map(feature.map((s) => [s.produces, s.owner]))
  // intake and define_success are HERMES and PRODUCT work, represented in the pipeline by scope; the rest map by artifact.
  for (const [artifact, owner] of [
    ['acceptance_criteria', 'tdt_product'], ['design', 'tdt_architect'], ['pull_request', 'tdt_backend'],
    ['test_report', 'tdt_qa'], ['review', 'tdt_sentinel'], ['release_plan', 'tdt_devops'], ['closure', 'tdt_hermes'],
  ] as const) {
    assert.equal(produced.get(artifact), owner, `feature pipeline: ${artifact} should be produced by ${owner}`)
  }
})

test('release readiness precedes release and release needs the owner', () => {
  const feature = pipelines.find((p) => p.doc.id === 'feature')!.doc.stages as any[]
  const ids = feature.map((s) => s.id)
  assert.ok(ids.indexOf('release_readiness') < ids.indexOf('release'))
  assert.ok(ids.indexOf('accept') > ids.indexOf('release'))
  assert.equal(feature.find((s) => s.id === 'release').approval, 'owner')
  assert.equal(feature.find((s) => s.id === 'release').consumes.includes('release_plan'), true)
})


test('no two units own the same path or a path inside another unit\'s', () => {
  const claims = units.flatMap((u) => u.owns_paths.map((p: string) => ({ id: u.id, p: p.replace(/\/$/, '') })))
  for (const a of claims) {
    for (const b of claims) {
      if (a.id === b.id) continue
      const nested = b.p === a.p || b.p.startsWith(a.p + '/')
      assert.equal(nested, false, `${a.id} owns ${a.p} and ${b.id} also claims ${b.p}`)
    }
  }
})

test('review ownership is separate from implementation ownership', () => {
  for (const u of units) {
    for (const r of u.reviews_paths ?? []) {
      assert.ok(!(u.owns_paths as string[]).includes(r), `${u.id} both owns and only reviews ${r}`)
    }
  }
  const sentinel = byId.get('tdt_sentinel')
  assert.ok(sentinel.reviews_paths.length >= 1, 'SENTINEL must review code it does not own')
})

test('every unit that writes workflow or chart files can actually reach them under the path gate', () => {
  // The repo-write allowlist admits team/; what this checks is that SOME unit owns team/workflows,
  // so a workflow file is never unreachable for want of an owner.
  const owners = units.filter((u) => u.owns_paths.some((p: string) => p === 'team/workflows' || p.startsWith('team/workflows/')))
  assert.equal(owners.length, 1, 'exactly one unit owns team/workflows')
})
