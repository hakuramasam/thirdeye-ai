import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'

const DIR = 'team/pipelines'
const ROSTER = new Set([
  'tdt_hermes','tdt_architect','tdt_sentinel','tdt_backend','tdt_frontend','tdt_blockchain',
  'tdt_intelligence','tdt_devops','tdt_agent-engineer','tdt_product','tdt_qa','tdt_docs',
])
const pipelines = readdirSync(DIR).filter((f) => f.endsWith('.pipeline.json')).map((f) => (
  { file: f, doc: JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) }
))

test('every pipeline declares an id, a trigger and stages', () => {
  assert.ok(pipelines.length >= 3)
  for (const { file, doc } of pipelines) {
    assert.ok(doc.id, file)
    assert.ok(doc.trigger && doc.trigger.length > 20, `${file} needs a real trigger`)
    assert.ok(Array.isArray(doc.stages) && doc.stages.length >= 4, `${file} needs stages`)
  }
})

test('every stage is owned by an agent that exists', () => {
  for (const { doc } of pipelines) {
    for (const s of doc.stages) {
      assert.ok(ROSTER.has(s.owner), `${doc.id}/${s.id} owned by unknown agent ${s.owner}`)
    }
  }
})

test('nothing reaches production without the owner approving it', () => {
  for (const { doc } of pipelines) {
    for (const s of doc.stages) {
      if (s.environment === 'production') {
        assert.equal(s.approval, 'owner', `${doc.id}/${s.id} promotes to production without owner approval`)
      }
    }
  }
})

test('every stage states a gate, because a stage without evidence is a wish', () => {
  for (const { doc } of pipelines) {
    for (const s of doc.stages) {
      assert.ok(s.gate && s.gate.length > 15, `${doc.id}/${s.id} has no gate`)
      assert.ok(s.purpose && s.purpose.length > 10, `${doc.id}/${s.id} has no stated purpose`)
    }
  }
})

test('a produced pull request is always verified before release', () => {
  for (const { doc } of pipelines) {
    const ids = doc.stages.map((s: any) => s.id)
    for (const s of doc.stages) {
      if (s.produces !== 'pull_request') continue
      const verifyIdx = ids.indexOf('verify')
      assert.ok(verifyIdx > ids.indexOf(s.id), `${doc.id} releases a patch with no verify stage after it`)
      const releaseIdx = ids.indexOf('release')
      assert.ok(releaseIdx === -1 || verifyIdx < releaseIdx, `${doc.id} releases before verifying`)
    }
  }
})

test('consumed artifacts are produced earlier in the same pipeline', () => {
  for (const { doc } of pipelines) {
    const produced = new Set<string>()
    for (const s of doc.stages) {
      for (const need of s.consumes ?? []) {
        assert.ok(produced.has(need), `${doc.id}/${s.id} consumes ${need} before anything produces it`)
      }
      produced.add(s.produces)
    }
  }
})

test('stage ids are unique and failures name a real next move', () => {
  const valid = new Set(['stop', 'warn', 'rollback', 'escalate_owner', 'back_to_patch', 'back_to_scope', 'back_to_build'])
  for (const { doc } of pipelines) {
    const seen = new Set<string>()
    for (const s of doc.stages) {
      assert.ok(!seen.has(s.id), `${doc.id} repeats stage id ${s.id}`)
      seen.add(s.id)
      assert.ok(valid.has(s.on_failure), `${doc.id}/${s.id} on_failure=${s.on_failure} is not a defined move`)
    }
  }
})
