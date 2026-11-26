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
    assert.equal(res.dispatch_attempt_run_id, undefined, 'a delivered handoff is not a failed attempt')
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
    // A replay used to be reported through dispatch_skipped, which cannot be true at the same time
    // as a populated `dispatched`. It has its own field now.
    assert.equal(second.dispatch_replayed, true, 'the call is reported as a replay')
    assert.equal(second.dispatch_skipped, undefined, 'a replay is not a skipped dispatch')

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

  it('never reports a failed orchestrator run as a dispatch', async () => {
    await query(`DELETE FROM agent_alerts`)
    // A new finding, so the brief hashes to a run id no earlier test has already executed. Without
    // it the dispatch would replay the stored success from the test above and prove nothing.
    await query(
      `INSERT INTO agent_runs (id, agent_id, user_id, status, input, output, tool_calls, spend_usd_micros)
       VALUES ($1, $2, $3, 'success', 'write the release notes', 'Deployed and shipped the release notes.', 1, 120)`,
      [randomUUID(), QA, owner.id]
    )
    const hermesRuns = async () =>
      Number(
        (await one(
          `SELECT count(*)::int AS n FROM agent_runs WHERE agent_id = $1 AND input LIKE 'Monitoring raised findings%'`,
          [HERMES]
        )).n
      )
    const runsBefore = await hermesRuns()

    // An unresolvable model is the honest way to make runAgent fail: it resolves
    // { status: 'error' } with the reason, which is why the monitor's `catch` never saw it and
    // reported the failure as a successful handoff.
    await query(`UPDATE agents SET model = 'no-such-model' WHERE id = $1`, [HERMES])
    try {
      const res = await auditAgents({ hours: 1, dispatch: true })

      assert.deepEqual(res.dispatched, [], 'a run that failed has not dispatched anything')
      assert.equal(res.dispatch_error, 'runner_error', 'the failure is named as a failure')
      assert.ok(res.dispatch_attempt_run_id, 'the attempt keeps an id so its record can be read')

      const run: any = await one(`SELECT status, error FROM agent_runs WHERE id = $1`, [res.dispatch_attempt_run_id])
      assert.equal(run.status, 'error', 'the stored run agrees that it failed')

      // The trail still points at the attempt: bookkeeping must not be lost because the run failed.
      const alert: any = await one(`SELECT dispatch_run_id FROM agent_alerts ORDER BY created_at DESC LIMIT 1`)
      assert.equal(alert.dispatch_run_id, res.dispatch_attempt_run_id)

      // And the same brief cannot be quietly retried into a second charge under the same id.
      await query(`DELETE FROM agent_alerts`)
      const again = await auditAgents({ hours: 1, dispatch: true })
      assert.deepEqual(again.dispatched, [])
      assert.equal(again.dispatch_error, 'runner_error')
      assert.equal(again.dispatch_replayed, true, 'a replay of a failed run is still reported as failed')
      assert.equal(await hermesRuns(), runsBefore + 1, 'one attempt, and no second charge for a replay')
    } finally {
      await query(`UPDATE agents SET model = 'thirdeye-mock' WHERE id = $1`, [HERMES])
      await query(`DELETE FROM agent_alerts`)
    }
  })

  it('one blocked alert link does not strand the alerts after it', async () => {
    await query(`DELETE FROM agent_alerts`)
    // Two fresh high findings, so the dispatch has two links to write. Each runs on its own run id,
    // and the dedupe key is code plus run id, so the two keys are known before the audit runs.
    const runA = randomUUID()
    const runB = randomUUID()
    for (const [runId, input] of [
      [runA, 'write the ops guide'],
      [runB, 'write the incident guide'],
    ]) {
      await query(
        `INSERT INTO agent_runs (id, agent_id, user_id, status, input, output, tool_calls, spend_usd_micros)
         VALUES ($1, $2, $3, 'success', $4, 'Deployed and shipped ' || $4 || '.', 1, 160)`,
        [runId, QA, owner.id, input]
      )
    }
    // Block only the first key. The old code wrapped the whole loop in one try, so the throw on the
    // first UPDATE abandoned the second alert: it stayed unlinked and nothing said so beyond a
    // single flag.
    const blocked = `unverified_claim:${runA}`
    await query(`CREATE OR REPLACE FUNCTION _block_one_link() RETURNS trigger AS $$
                 BEGIN
                   IF OLD.dedupe_key = '${blocked}' THEN RAISE EXCEPTION 'link blocked for test'; END IF;
                   RETURN NEW;
                 END; $$ LANGUAGE plpgsql`)
    await query(`CREATE TRIGGER _block_one_link BEFORE UPDATE ON agent_alerts
                 FOR EACH ROW EXECUTE FUNCTION _block_one_link()`)
    try {
      const res = await auditAgents({ hours: 1, dispatch: true })

      assert.equal(res.dispatched.length, 1, 'the orchestrator still answered')
      assert.equal(res.alert_link_error, true, 'the failure is still reported')
      assert.equal(res.dispatch_attempt_run_id, undefined, 'a success is not an attempt')

      const linked: any = await query(`SELECT dedupe_key, dispatch_run_id FROM agent_alerts ORDER BY dedupe_key`)
      const byKey = new Map(linked.rows.map((r: any) => [r.dedupe_key, r.dispatch_run_id]))
      assert.equal(byKey.get(blocked), null, 'the blocked alert stayed unlinked')
      assert.equal(
        byKey.get(`unverified_claim:${runB}`),
        res.dispatched[0],
        'the alert after the blocked one is linked anyway'
      )
    } finally {
      await query(`DROP TRIGGER IF EXISTS _block_one_link ON agent_alerts`)
      await query(`DROP FUNCTION IF EXISTS _block_one_link()`)
      await query(`DELETE FROM agent_alerts`)
    }
  })

  it('an alert-link failure cannot conceal a successful run', async () => {
    await query(`DELETE FROM agent_alerts`)
    // A third distinct finding, for the same reason: a deterministic run id would otherwise replay
    // the failed run from the test above rather than exercise a fresh success.
    await query(
      `INSERT INTO agent_runs (id, agent_id, user_id, status, input, output, tool_calls, spend_usd_micros)
       VALUES ($1, $2, $3, 'success', 'write the migrations guide', 'Deployed and shipped the migrations guide.', 1, 140)`,
      [randomUUID(), QA, owner.id]
    )
    await query(`CREATE OR REPLACE FUNCTION _block_alert_link() RETURNS trigger AS $$
                 BEGIN RAISE EXCEPTION 'link blocked for test'; END; $$ LANGUAGE plpgsql`)
    await query(`CREATE TRIGGER _block_alert_link BEFORE UPDATE ON agent_alerts
                 FOR EACH ROW EXECUTE FUNCTION _block_alert_link()`)
    try {
      const res = await auditAgents({ hours: 1, dispatch: true })

      assert.equal(res.dispatched.length, 1, 'the run succeeded and must be reported as dispatched')
      assert.equal(res.dispatch_error, undefined, 'bookkeeping must not be reported as a runner failure')
      assert.equal(res.alert_link_error, true, 'the linking failure is visible on its own')

      const run: any = await one(`SELECT status FROM agent_runs WHERE id = $1`, [res.dispatched[0]])
      assert.equal(run.status, 'success')
    } finally {
      await query(`DROP TRIGGER IF EXISTS _block_alert_link ON agent_alerts`)
      await query(`DROP FUNCTION IF EXISTS _block_alert_link()`)
      await query(`DELETE FROM agent_alerts`)
    }
  })

  it('derives the run id from the findings, in any order', () => {
    assert.equal(dispatchRunId(['a', 'b']), dispatchRunId(['b', 'a']), 'order must not matter')
    assert.notEqual(dispatchRunId(['a']), dispatchRunId(['a', 'b']), 'different briefs differ')
    assert.match(dispatchRunId(['x']), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
