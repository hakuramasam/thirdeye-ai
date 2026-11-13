process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const {
  storeArtifact,
  readArtifact,
  readArtifactWindow,
  listArtifacts,
  validateArtifact,
  kindForStage,
  describeArtifact,
  MAX_ARTIFACT_CHARS,
} = await import('../src/agents/artifacts.js')
const { runAgent } = await import('../src/agents/runner.js')
import type { AgentRow } from '../src/agents/runner.js'

function scriptedLlm(script: Array<{ content?: string; tool_calls?: any[] }>) {
  let i = 0
  return {
    call: async () => {
      const step = script[Math.min(i, script.length - 1)]
      i++
      return { content: step.content ?? '', prompt_tokens: 1, completion_tokens: 1, tool_calls: step.tool_calls }
    },
  }
}

const toolCall = (name: string, args: Record<string, unknown>) => ({
  id: `call_${Math.random().toString(16).slice(2)}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
})

describe('PH2-003 addressable artifacts', () => {
  let user: any
  let other: any

  before(async () => {
    await migrate()
    user = { id: randomUUID(), wallet: `0x${'7'.repeat(40)}`, role: 'user', created_at: new Date().toISOString() }
    other = { id: randomUUID(), wallet: `0x${'8'.repeat(40)}`, role: 'user', created_at: new Date().toISOString() }
    for (const u of [user, other]) {
      await query(`INSERT INTO users (id, wallet, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u.id, u.wallet, u.role])
    }
  })

  it('refuses an unknown kind, empty content and an oversized document', () => {
    assert.equal((validateArtifact({ kind: 'secrets', content: 'x' }) as any).code, 'invalid_kind')
    assert.equal((validateArtifact({ kind: 'report', content: '  ' }) as any).code, 'empty_content')
    const big = validateArtifact({ kind: 'report', content: 'x'.repeat(MAX_ARTIFACT_CHARS + 1) }) as any
    assert.equal(big.code, 'artifact_too_large')
    const ok = validateArtifact({ kind: 'Test_Report', content: 'all green', title: 'suite' }) as any
    assert.equal(ok.ok, true)
    assert.equal(ok.kind, 'test_report')
  })

  it('stores content under an address and reads it back byte for byte', async () => {
    const text = '# diagnosis\n\ncause: the retry loop ignores 429.\n'
    const stored = await storeArtifact({ userId: user.id, kind: 'diagnosis', content: text, correlationId: 'cor_1', createdBy: 'QA' })
    assert.match(stored.id, /^art_[0-9a-f]{20}$/)
    assert.equal(stored.version, 1)
    assert.equal(stored.deduped, false)
    const read = await readArtifactWindow(user.id, stored.id)
    assert.equal(read.ok, true)
    assert.equal((read as any).content, text)
    assert.equal((read as any).truncated, false)
  })

  it('does not grow a version when the same bytes are handed on twice', async () => {
    const first = await storeArtifact({ userId: user.id, kind: 'review', content: 'no findings', correlationId: 'cor_2', stageId: 'security_review' })
    const again = await storeArtifact({ userId: user.id, kind: 'review', content: 'no findings', correlationId: 'cor_2', stageId: 'security_review' })
    assert.equal(again.id, first.id)
    assert.equal(again.deduped, true)
    const rows = await listArtifacts(user.id, { correlationId: 'cor_2' })
    assert.equal(rows.length, 1)
  })

  it('keeps the earlier version readable when the same stage hands on a corrected document', async () => {
    const v1 = await storeArtifact({ userId: user.id, kind: 'pull_request', content: '#1 diff body', correlationId: 'cor_3', stageId: 'patch' })
    const v2 = await storeArtifact({ userId: user.id, kind: 'pull_request', content: '#1 diff body, redacted key', correlationId: 'cor_3', stageId: 'patch' })
    assert.equal(v1.id === v2.id, false)
    assert.equal(v2.version, 2)
    assert.equal((await readArtifact(user.id, v1.id))?.version, 1)
    assert.equal((await readArtifact(user.id, v2.id))?.version, 2)
  })

  it('answers a stranger exactly like a missing address', async () => {
    const stored = await storeArtifact({ userId: user.id, kind: 'note', content: 'owner only', correlationId: 'cor_4' })
    const asOther = await readArtifactWindow(other.id, stored.id)
    assert.equal(asOther.ok, false)
    assert.equal((asOther as any).code, 'not_found')
    assert.equal((await readArtifactWindow(other.id, 'art_00000000000000000000') as any).code, 'not_found')
    assert.equal((await readArtifactWindow(user.id, 'nonsense') as any).code, 'invalid_address')
  })

  it('pages a long document by offset instead of truncating it', async () => {
    const long = 'x'.repeat(9000)
    const stored = await storeArtifact({ userId: user.id, kind: 'report', content: long, correlationId: 'cor_5' })
    const page1 = await readArtifactWindow(user.id, stored.id, { limit: 4000 })
    assert.equal((page1 as any).content.length, 4000)
    assert.equal((page1 as any).truncated, true)
    const page2 = await readArtifactWindow(user.id, stored.id, { limit: 4000, offset: (page1 as any).next_offset })
    assert.equal((page2 as any).content.length, 4000)
    const page3 = await readArtifactWindow(user.id, stored.id, { limit: 4000, offset: (page2 as any).next_offset })
    assert.equal((page3 as any).content.length, 1000)
    assert.equal((page3 as any).truncated, false)
  })

  it('names the kind a stage produces rather than letting the run relabel it', () => {
    assert.equal(kindForStage('bugfix', 'diagnose'), 'diagnosis')
    assert.equal(kindForStage('bugfix', 'verify'), 'test_report')
    assert.equal(kindForStage('bugfix', 'release'), 'release')
    assert.equal(kindForStage(null, 'anything'), 'report')
    assert.equal(kindForStage('feature', 'not_a_stage'), 'report')
  })

  it('addresses a delegated report instead of pasting the whole thing into the parent', async () => {
    const parent = (await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
       VALUES ($1,$2,'HERMES','coordinate','stub-model',true,'none',100000,4) RETURNING *`,
      [`tdt_p_${randomUUID().slice(0, 6)}`, user.id]
    )) as AgentRow
    await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
       VALUES ($1,$2,'QA','verify','stub-model',false,'none',100000,4) RETURNING *`,
      [`tdt_c_${randomUUID().slice(0, 6)}`, user.id]
    )
    const longReport = `VERIFIED: ${'detail '.repeat(600)}`
    // One shared script: the parent's first step delegates, the child then answers with the long
    // report, and the parent closes. That is also the order the real handoff happens in.
    const llm = scriptedLlm([
      { tool_calls: [toolCall('delegate_to_agent', { agent: 'QA', task: 'verify the patch' })] },
      { content: longReport },
      { content: 'coordinated: see QA report' },
    ])
    const res = await runAgent(parent, 'ship it', user, { llm, roster: 'QA' })
    assert.equal(res.status, 'success')
    // The child's own run stored its report; the parent saw an address and a short head.
    const childArtifact = await one(
      `SELECT * FROM agent_artifacts WHERE user_id = $1 AND created_by = 'QA' ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    )
    assert.ok(childArtifact, 'the child report should be addressable')
    assert.equal(childArtifact.content, longReport)
    // The child kept its whole report: the registry is where truncation stops, not where it starts.
    assert.equal(childArtifact.content.length, longReport.length)
    assert.equal(childArtifact.kind, 'report')
    assert.match(describeArtifact(childArtifact), /^art_[0-9a-f]{20} \(report/)
    assert.match(describeArtifact(childArtifact), /kB\)$/)
  })
})
