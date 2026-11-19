import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const matrix = JSON.parse(readFileSync(new URL('../team/competency-matrix.json', import.meta.url), 'utf8'))
const scenarios = JSON.parse(readFileSync(new URL('../team/competency-scenarios.json', import.meta.url), 'utf8'))

test('all twelve agents have normal, edge, malicious and refusal competency challenges', () => {
  assert.equal(scenarios.agents.length, 12)
  assert.equal(matrix.agents.length, 12)
  const ids = new Set(matrix.agents.map((agent: any) => agent.id))
  for (const role of scenarios.agents) {
    assert.ok(ids.has(role.id), 'scenario must map to a competency matrix role: ' + role.id)
    for (const key of ['scenario','normal','edge','malicious','refusal']) assert.ok(String(role[key] ?? '').trim().length > 8, role.id + ' missing ' + key)
  }
  for (const key of ['normal','edge','malicious','refusal']) assert.ok(scenarios.global_adversarial_cases[key])
  assert.ok(matrix.agents.every((agent: any) => agent.status === 'untested'), 'scenario definitions must never graduate an agent')
})
