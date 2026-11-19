import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'

const org = JSON.parse(readFileSync('team/organization.json', 'utf8'))
const matrix = JSON.parse(readFileSync('team/competency-matrix.json', 'utf8'))
const registry = JSON.parse(readFileSync('team/skill-source-registry.json', 'utf8'))

test('competency matrix covers every live agent exactly once', () => {
  const roster = org.units.map((unit: any) => unit.id).sort()
  const assessed = matrix.agents.map((agent: any) => agent.id).sort()
  assert.deepEqual(assessed, roster)
  assert.equal(new Set(assessed).size, assessed.length)
})

test('all role skill packs have standard metadata and competency contracts', () => {
  for (const agent of matrix.agents) {
    assert.ok(existsSync(agent.skill), `${agent.id} skill pack exists`)
    const skill = readFileSync(agent.skill, 'utf8')
    assert.match(skill, /^---\n[\s\S]*?\n---\n/)
    assert.match(skill, /^name: [a-z0-9-]+$/m)
    assert.match(skill, /^description: .{20,}$/m)
    assert.match(skill, /^  version: "2\.0\.0"$/m)
    assert.match(skill, /## Capability contract/)
    assert.match(skill, /## Freshness and evidence rules/)
  }
})

test('no agent is marked competent without a practical evaluation', () => {
  for (const agent of matrix.agents) {
    assert.equal(agent.status, 'untested')
    assert.ok(agent.scenario)
    assert.ok(agent.critical_gates.length > 0)
  }
})

test('external skill sources are registered but not automatically imported', () => {
  assert.ok(registry.sources.length >= 8)
  for (const source of registry.sources) {
    assert.ok(source.url)
    assert.ok(source.roles.length)
    assert.equal(source.imported, false)
    assert.ok(source.license_review)
  }
})

test('authority policy keeps merge, production and financial actions owner-controlled', () => {
  const policy = readFileSync('docs/team/authority-eligibility.md', 'utf8')
  assert.match(policy, /Human owner approval remains mandatory/)
  assert.match(policy, /never substitutes for independent human financial\/security acceptance/)
})
