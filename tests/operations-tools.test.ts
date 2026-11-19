import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCiRef, validateCommitSha, canRunCiForAgent } from '../src/agents/operations-tools.js'

test('CI dispatch accepts only bounded review branches', () => {
  assert.equal(validateCiRef('work/feature-123'), 'work/feature-123')
  assert.equal(validateCiRef('agent/qa-check'), 'agent/qa-check')
  for (const ref of ['main', 'master', '../main', 'work/../main', 'work//bad', 'release/v1']) {
    assert.throws(() => validateCiRef(ref))
  }
})

test('check-run lookup requires a full commit SHA', () => {
  assert.equal(validateCommitSha('a'.repeat(40)), 'a'.repeat(40))
  for (const sha of ['a'.repeat(39), 'a'.repeat(41), 'latest', '']) assert.throws(() => validateCommitSha(sha))
})

test('only QA, DEVOPS, HERMES and agent-engineer may dispatch repository CI', () => {
  for (const id of ['tdt_hermes', 'tdt_qa', 'tdt_devops', 'tdt_agent-engineer']) assert.equal(canRunCiForAgent(id), true)
  for (const id of ['tdt_product', 'tdt_backend', 'tdt_frontend', 'tdt_blockchain', 'tdt_intelligence', 'tdt_sentinel', 'tdt_docs']) assert.equal(canRunCiForAgent(id), false)
})
