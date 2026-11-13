process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const { runAgent, errorCodeFrom } = await import('../src/agents/runner.js')
const { readAuditEvents, newCorrelationId } = await import('../src/agents/audit-log.js')
import type { AgentRow } from '../src/agents/runner.js'

/** A model stub that answers from a script; the last entry repeats so a loop always terminates. */
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

const toolCall = (name: string, args: Record<string, unknown>, id = `call_${Math.random().toString(16).slice(2)}`) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
})

describe('PH2-001 correlation across executions', () => {
  let user: any
  let parent: AgentRow
  let child: AgentRow

  before(async () => {
    await migrate()
    user = { id: randomUUID(), wallet: `0x${'9'.repeat(40)}`, role: 'user', created_at: new Date().toISOString() }
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      user.id,
      user.wallet,
      user.role,
    ])

    parent = (await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
       VALUES ($1, $2, 'HERMES', 'coordinate', 'stub-model', true, 'none', 100000, 4) RETURNING *`,
      [`tdt_parent_${randomUUID().slice(0, 6)}`, user.id]
    )) as AgentRow
    child = (await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
       VALUES ($1, $2, 'QA', 'verify', 'stub-model', false, 'none', 100000, 4) RETURNING *`,
      [`tdt_child_${randomUUID().slice(0, 6)}`, user.id]
    )) as AgentRow
  })

  it('gives a root execution one correlation id and its own run id', async () => {
    const res = await runAgent(parent, 'say hello', user, {
      llm: scriptedLlm([{ content: 'hello' }]),
      roster: 'QA',
    })
    assert.equal(res.status, 'success')

    const events = await readAuditEvents({ runId: res.runId })
    assert.ok(events.length >= 3, `expected lifecycle events, got ${events.length}`)
    const correlations = new Set(events.map((e) => e.correlation_id))
    assert.equal(correlations.size, 1, 'one execution must not scatter across correlation ids')
    const [correlation] = [...correlations]
    assert.match(correlation, /^corr_[0-9a-f-]{36}$/)
    assert.deepEqual(
      events.map((e) => e.event_type),
      // PH2-003: the run's output is addressed before the run is reported complete, so the
      // artifact event sits between start and completion rather than after it.
      ['run.created', 'run.started', 'artifact.created', 'run.completed']
    )
    const artifactEvent = events.find((e) => e.event_type === 'artifact.created')
    assert.ok(artifactEvent, 'a successful run with output must address it')
    const artifactIds = (artifactEvent as any).artifact_ids
    assert.equal(Array.isArray(artifactIds) ? artifactIds.length : 0, 1)
    assert.match(String(artifactIds[0]), /^art_[0-9a-f]{20}$/)
    assert.equal(events.every((e) => e.run_id === res.runId), true)
    assert.equal(events[0].agent_role, parent.name)
  })

  it('makes a delegated run inherit the correlation id with its own run id and parent link', async () => {
    const correlationId = newCorrelationId()
    const res = await runAgent(parent, 'delegate the verification', user, {
      correlationId,
      pipelineId: 'feature',
      stageId: 'EXECUTING',
      roster: 'QA',
      llm: scriptedLlm([
        { tool_calls: [toolCall('delegate_to_agent', { agent: 'QA', task: 'verify the build output' })] },
        { content: 'verified' },
      ]),
    })
    assert.equal(res.status, 'success')

    const chain = await readAuditEvents({ correlationId })
    const types = chain.map((e) => e.event_type)
    assert.ok(types.includes('task.delegated'), 'the handoff must be recorded')
    assert.ok(types.includes('task.completed'), 'the outcome must be recorded')
    assert.ok(types.includes('tool.invoked'), 'the delegation tool call must be recorded')

    const delegated = chain.find((e) => e.event_type === 'task.delegated')!
    assert.equal(delegated.run_id, res.runId)
    assert.equal(delegated.pipeline_id, 'feature')
    assert.equal(delegated.stage_id, 'EXECUTING')
    assert.ok(delegated.task_id, 'the handoff carries its task id')

    const childEvents = await readAuditEvents({ parentRunId: res.runId })
    assert.ok(childEvents.length >= 2, 'the child run must appear with this run as its parent')
    assert.equal(childEvents.every((e) => e.correlation_id === correlationId), true)
    const childRunIds = new Set(childEvents.map((e) => e.run_id))
    assert.equal(childRunIds.size, 1, 'one delegated run')
    const childRunId = [...childRunIds][0]
    assert.notEqual(childRunId, res.runId, 'a child run has its own run id')
    assert.equal(childEvents.every((e) => e.parent_run_id === res.runId), true)
    assert.equal(childEvents.some((e) => e.event_type === 'run.completed'), true)

    // One correlation id reconstructs the whole chain: two runs, parent then child.
    const rootRunIds = new Set(chain.map((e) => e.run_id))
    assert.equal(rootRunIds.size, 2)
  })

  it('records a refused tool as a denial with its reason, and allows a permitted tool', async () => {
    const res = await runAgent(parent, 'try to write', user, {
      llm: scriptedLlm([
        { tool_calls: [toolCall('repo_write', { files: [{ path: 'src/x.ts', content: 'x' }] })] },
        { content: 'could not write' },
      ]),
      roster: 'QA',
    })
    assert.equal(res.status, 'success')

    const events = await readAuditEvents({ runId: res.runId })
    const denied = events.find((e) => e.event_type === 'tool.denied')!
    assert.ok(denied, 'a refused tool must not be logged as a normal call')
    assert.equal(denied.tool_name, 'repo_write')
    assert.equal(denied.status, 'denied')
    assert.match(String((denied.metadata as any).denial_reason), /write authority/)
  })

  it('records a failed run with an error code rather than losing it', async () => {
    const res = await runAgent(
      parent,
      'explode',
      user,
      { llm: { call: async () => { throw new Error('provider fell over') } }, roster: 'QA' }
    )
    assert.equal(res.status, 'error')

    const events = await readAuditEvents({ runId: res.runId })
    const failed = events.find((e) => e.event_type === 'run.failed')!
    assert.ok(failed, 'a crash must leave a failed event')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error_code, 'uncaught_exception')
    assert.equal(events.some((e) => e.event_type === 'run.completed'), false)
  })

  it('never stores a credential that appeared in tool arguments', async () => {
    const res = await runAgent(parent, 'fetch something', user, {
      llm: scriptedLlm([
        { tool_calls: [toolCall('http_fetch', { url: 'https://example.com', body: 'sk-thirdeye-abcdef1234567890' })] },
        { content: 'done' },
      ]),
      roster: 'QA',
    })
    const events = await readAuditEvents({ runId: res.runId })
    const blob = JSON.stringify(events)
    assert.equal(blob.includes('sk-thirdeye-abcdef1234567890'), false, 'the key shape leaked into the audit trail')
    assert.equal(blob.includes('sk-***'), true, 'the argument was recorded with the credential scrubbed')
  })

  it('maps known failures to stable codes', () => {
    assert.equal(errorCodeFrom('Insufficient credits. Top up with USDC'), 'insufficient_credits')
    assert.equal(errorCodeFrom('Budget exceeded'), 'budget_exceeded')
    assert.equal(errorCodeFrom('Max steps (4) reached without a final answer'), 'max_steps')
    assert.equal(errorCodeFrom("Model 'nope' not found in catalog"), 'model_not_found')
    assert.equal(errorCodeFrom('uncaught: boom'), 'uncaught_exception')
    assert.equal(errorCodeFrom('something else'), 'run_failed')
  })
})
