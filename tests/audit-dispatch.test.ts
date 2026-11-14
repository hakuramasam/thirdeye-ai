process.env.PGLITE_DIR = 'memory://'

/**
 * The audit-to-HERMES handoff.
 *
 * Production defect, verified at 772dfad: `POST /api/admin/agents/audit` passes only `hermesId`,
 * and `auditAgents` gated the whole dispatch on `opts.dispatch && opts.hermesId && opts.ownerUserId`.
 * So `dispatch: true` created alerts and answered `dispatched: []` every time: no finding ever
 * reached HERMES. The handoff also passed `{ idempotencyKey: ... } as any`, while `runAgent` reads
 * `runId`, so every attempt minted a fresh run id and nothing could ever replay.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const { auditAgents, dispatchRunId } = await import('../src/agents/monitor.js')

const HERMES = 'tdt_hermes'
const QA = 'tdt_qa'

describe('audit hands the worst findings to HERMES', () => {
  let owner: any

  before(async () => {
    await migrate()
    owner = { id: randomUUID(), wallet: `0x${'5'.repeat(40)}` }
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, 'user')`, [owner.id, owner.wallet])
    // The mock model answers in-process, so a dispatch can be exercised without a network.
    for (const [id, name] of [[HERMES, 'HERMES'], [QA, 'QA']]) {
      await query(
        `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access,
                             budget_usd_micros, max_steps, status)
         VALUES ($1, $2, $3, 'work', 'thirdeye-mock', false, 'none', 100000, 4, 'active')`,
        [id, owner.id, name]
      )
    }
    // A success that claims the work shipped and quotes no measurement: the one high-severity
    // finding the monitor raises without needing tool events.
    await query(
      `INSERT INTO agent_runs (id, agent_id, user_id, status, input, output, tool_calls, spend_usd_micros)
       VALUES ($1, $2, $3, 'success', 'write the docs', 'Deployed and shipped the new docs.', 1, 100)`,
      [randomUUID(), QA, owner.id]
    )
  })

  it('dispatches without being told who the owner is', async () => {
    const res = await auditAgents({ hours: 1, dispatch: true })

    assert.equal(res.created, 1, 'the finding must become an alert')
    assert.equal(res.dispatched.length, 1, 'the finding must reach HERMES')
    const runId = res.dispatched[0]

    const run: any = await one(`SELECT agent_id, status FROM agent_runs WHERE id = $1`, [runId])
    assert.equal(run.agent_id, HERMES, 'the brief runs as the orchestrator')
    assert.equal(run.status, 'success', 'the orchestrator answered')

    const alert: any = await one(`SELECT dispatch_run_id FROM agent_alerts ORDER BY created_at DESC LIMIT 1`)
    assert.equal(alert.dispatch_run_id, runId, 'the alert records the run that answered it')
  })

  it('replays the same dispatch instead of paying for a second run', async () => {
    // Clearing the alerts makes the same findings fresh again: exactly the shape of a retried or
    // duplicated audit call over the same window.
    await query(`DELETE FROM agent_alerts`)
    const first = await auditAgents({ hours: 1, dispatch: true })
    assert.equal(first.dispatched.length, 1)
    const runId = first.dispatched[0]

    await query(`DELETE FROM agent_alerts`)
    const second = await auditAgents({ hours: 1, dispatch: true })
    assert.deepEqual(second.dispatched, [runId], 'the same brief maps to the same run id')
    assert.equal(second.dispatch_skipped, 'replayed')

    const runs: any = await one(
      `SELECT count(*)::int AS n FROM agent_runs WHERE agent_id = $1 AND input LIKE 'Monitoring raised findings%'`,
      [HERMES]
    )
    assert.equal(Number(runs.n), 1, 'one brief, one run')
  })

  it('fails closed when there is no orchestrator to hand the brief to', async () => {
    await query(`DELETE FROM agent_alerts`)
    const res = await auditAgents({ hours: 1, dispatch: true, hermesId: 'tdt_missing' })
    assert.deepEqual(res.dispatched, [], 'nothing is reported as dispatched')
    assert.equal(res.dispatch_skipped, 'hermes_not_found')

    const runs: any = await one(`SELECT count(*)::int AS n FROM agent_runs WHERE agent_id = 'tdt_missing'`)
    assert.equal(Number(runs.n), 0, 'no run row is invented')
  })

  it('derives the run id from the findings, in any order', () => {
    assert.equal(dispatchRunId(['a', 'b']), dispatchRunId(['b', 'a']), 'order must not matter')
    assert.notEqual(dispatchRunId(['a']), dispatchRunId(['a', 'b']), 'different briefs differ')
    assert.match(dispatchRunId(['x']), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
