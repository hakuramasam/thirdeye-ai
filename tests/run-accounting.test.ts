process.env.PGLITE_DIR = 'memory://'

/**
 * What a run says it did has to match what it was charged for.
 *
 * Two records disagreed in production on 2026-11-11: the HERMES pot moved 4,996 micro-dollars
 * while its runs recorded 2,731, because a run killed by an uncaught throw was closed by the
 * crash path, which wrote status and error only. The steps had already been paid for, so the
 * spend and the tool count were both lost. The same day a successful delegation was stored as a
 * refused call, because the run-event verdict was guessed from the result text and the handoff
 * carries the note "[write withheld]" when no write authority was granted.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const { runAgent } = await import('../src/agents/runner.js')
import type { AgentRow } from '../src/agents/runner.js'

/** A model stub that answers from a script; the last entry repeats so a loop always terminates. */
function scriptedLlm(script: Array<{ content?: string; tool_calls?: any[]; throws?: string }>) {
  let i = 0
  return {
    call: async () => {
      const step = script[Math.min(i, script.length - 1)]
      i++
      if (step.throws) throw new Error(step.throws)
      return { content: step.content ?? '', prompt_tokens: 10, completion_tokens: 5, tool_calls: step.tool_calls }
    },
  }
}

const toolCall = (name: string, args: Record<string, unknown>, id = `call_${Math.random().toString(16).slice(2)}`) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
})

/** A priced model, so a step actually costs money and the pot is really debited. */
const PRICED_MODEL = 'gpt-4o-mini'

describe('run accounting survives a crash', () => {
  let user: any

  before(async () => {
    await migrate()
    user = { id: randomUUID(), wallet: `0x${'7'.repeat(40)}`, role: 'user', created_at: new Date().toISOString() }
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      user.id,
      user.wallet,
      user.role,
    ])
  })

  it('records the spend and the tool calls a crashed run already made', async () => {
    const agent = (await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access,
                           budget_usd_micros, max_steps, credit_usd_micros)
       VALUES ($1, $2, 'CRASHER', 'work', $3, false, 'none', 100000, 4, 1000) RETURNING *`,
      [`tdt_crash_${randomUUID().slice(0, 6)}`, user.id, PRICED_MODEL]
    )) as AgentRow

    const res = await runAgent(agent, 'do some work', user, {
      // One paid step that calls a tool, then the provider dies. The step was billed before the
      // throw, so both numbers exist and both used to be thrown away.
      llm: scriptedLlm([
        { tool_calls: [toolCall('repo_read', { op: 'list', path: '' })] },
        { throws: 'provider fell over' },
      ]),
    })

    assert.equal(res.status, 'error')
    assert.match(String(res.error), /^uncaught:/)
    assert.equal(res.tool_calls, 1, 'the tool call happened and must be counted')
    assert.ok(res.spend_usd_micros > 0, 'the paid step must be counted')

    const row: any = await one(
      `SELECT status, error, tool_calls, spend_usd_micros FROM agent_runs WHERE id = $1`,
      [res.runId]
    )
    assert.equal(row.status, 'error')
    assert.equal(Number(row.tool_calls), 1, 'the row must carry the tool count, not zero')
    assert.equal(Number(row.spend_usd_micros), res.spend_usd_micros, 'the row must carry the spend')

    const pot: any = await one(`SELECT credit_usd_micros FROM agents WHERE id = $1`, [agent.id])
    assert.equal(
      1000 - Number(pot.credit_usd_micros),
      Number(row.spend_usd_micros),
      'the pot must have moved by exactly the spend the run recorded'
    )
  })

  it('stores a successful delegation as a call that worked, not as a refusal', async () => {
    const parent = (await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access,
                           budget_usd_micros, max_steps)
       VALUES ($1, $2, 'HERMES', 'coordinate', 'thirdeye-mock', true, 'none', 100000, 4) RETURNING *`,
      [`tdt_parent_${randomUUID().slice(0, 6)}`, user.id]
    )) as AgentRow
    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access,
                           budget_usd_micros, max_steps)
       VALUES ($1, $2, 'QA', 'verify', 'thirdeye-mock', false, 'none', 100000, 4)`,
      [`tdt_child_${randomUUID().slice(0, 6)}`, user.id]
    )

    const res = await runAgent(parent, 'hand the checklist to QA', user, {
      llm: scriptedLlm([
        { tool_calls: [toolCall('delegate_to_agent', { agent: 'QA', task: 'Summarize the deployment checklist in two sentences.' })] },
        { content: 'done' },
      ]),
      roster: 'QA',
      // No write authority for this task, which is what puts "[write withheld]" in the handoff.
    })
    assert.equal(res.status, 'success')

    const events = await query(
      `SELECT tool, ok, refused FROM agent_run_events WHERE run_id = $1 AND tool = 'delegate_to_agent'`,
      [res.runId]
    )
    assert.equal(events.rows.length, 1, 'one delegation call')
    const call: any = events.rows[0]
    assert.equal(call.refused, false, 'a handoff that produced a report was not refused')
    assert.equal(call.ok, true, 'a handoff that produced a report worked')

    // The handoff really was accepted, so this is not a mislabelled refusal of nothing.
    const child: any = await one(
      `SELECT count(*)::int AS n FROM agent_audit_events
        WHERE run_id = $1 AND event_type = 'task.delegated'`,
      [res.runId]
    )
    assert.equal(Number(child.n), 1, 'the delegation must have reached the teammate')
  })
})
