process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

const { migrate, query } = await import('../src/db/index.js')
const { splitDebit, payForStep, getAgentCredit, takeAgentCredit, fundAgentCredit, refundAgentCredit } =
  await import('../src/agents/credit.js')
const { isCronDue, lastScheduledInstant, parseCron } = await import('../src/agents/cron.js')

/**
 * Two defects are covered here, and both were invisible while the team looked idle:
 *  - a schedule tick only ran if the pinger arrived inside the agent's exact minute, so a
 *    slot that passed while nothing invoked the route was lost for good;
 *  - agents had no pot of their own, so funding was all-or-nothing on one shared balance.
 */

describe('per-agent inference credit', () => {
  before(async () => {
    await migrate()
    // agents.user_id is a foreign key, so the probes need a real owner row
    await query(
      `INSERT INTO users (id, wallet, role) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      ['probe_owner', '0xprobe000000000000000000000000000000000001', 'user']
    )
  })

  it('spends the pot first and bills only the remainder to the ledger', () => {
    assert.deepEqual(splitDebit(500, 300), { fromPot: 300, fromLedger: 0 })
    assert.deepEqual(splitDebit(100, 300), { fromPot: 100, fromLedger: 200 })
    assert.deepEqual(splitDebit(0, 42), { fromPot: 0, fromLedger: 42 })
    assert.deepEqual(splitDebit(1000, 0), { fromPot: 0, fromLedger: 0 })
    // a negative pot is treated as empty rather than as money we owe ourselves
    assert.deepEqual(splitDebit(-50, 10), { fromPot: 0, fromLedger: 10 })
  })

  it('a funded agent pays its own way, and the pot is deducted exactly once', async () => {
    const id = 'tdt_credit_probe'
    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, credit_usd_micros)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET credit_usd_micros = $6`,
      [id, 'probe_owner', 'CREDIT PROBE', 'x', 'ministral-3b', 50_000_000]
    )
    assert.equal(await getAgentCredit(id), 50_000_000)

    // 120 micros, an owner wallet with no allowance: everything must come from the pot,
    // so no ledger row is written at all.
    const paid = await payForStep({ agentId: id, userId: 'probe_owner', wallet: '0xprobe', runId: 'run-1', costMicros: 120 })
    assert.deepEqual(paid, { ok: true, fromPot: 120, fromLedger: 0 })
    assert.equal(await getAgentCredit(id), 50_000_000 - 120)

    // an empty pot falls through to the ledger, which refuses: the step fails whole
    await fundAgentCredit(id, 0, 'set')
    const refused = await payForStep({ agentId: id, userId: 'probe_owner', wallet: '0xprobe', runId: 'run-2', costMicros: 10 })
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'insufficient_credits')
    assert.equal(await getAgentCredit(id), 0, 'a refused step must not leave a pot balance moved')

    await query(`DELETE FROM agents WHERE id = $1`, [id])
  })

  it('cannot take more than the pot holds, even under two concurrent spends', async () => {
    const id = 'tdt_credit_race'
    await fundAgentCredit(id, 0, 'set').catch(() => null)
    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, credit_usd_micros)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET credit_usd_micros = $6`,
      [id, 'probe_owner', 'RACE PROBE', 'x', 'ministral-3b', 100]
    )
    const [a, b] = await Promise.all([takeAgentCredit(id, 80), takeAgentCredit(id, 80)])
    assert.equal(a + b, 80, 'only one of the two spends can win the same micros')
    assert.equal(await getAgentCredit(id), 20)

    await refundAgentCredit(id, 80)
    assert.equal(await getAgentCredit(id), 100, 'a refund restores exactly what was taken')

    await query(`DELETE FROM agents WHERE id = $1`, [id])
  })

  it('funding is add by default and set when asked', async () => {
    const id = 'tdt_credit_fund'
    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [id, 'probe_owner', 'FUND PROBE', 'x', 'ministral-3b']
    )
    assert.equal(await fundAgentCredit(id, 50_000_000), 50_000_000)
    assert.equal(await fundAgentCredit(id, 1_000_000), 51_000_000)
    assert.equal(await fundAgentCredit(id, 2_000_000, 'set'), 2_000_000)
    assert.equal(await fundAgentCredit('tdt_no_such_agent', 1), null)
    await query(`DELETE FROM agents WHERE id = $1`, [id])
  })
})

describe('a missed schedule slot runs late instead of being lost', () => {
  it('keeps strict minute matching when no lookback is given', () => {
    assert.equal(isCronDue('30 * * * *', new Date('2026-10-01T10:30:00Z'), null), true)
    assert.equal(isCronDue('30 * * * *', new Date('2026-10-01T10:31:00Z'), null), false)
  })

  it('picks up a daily slot that passed hours ago', () => {
    // The pinger arrived at 18:30, the agent is scheduled for 09:00, and it has not run
    // since the day before: exactly the situation that produced zero automatic runs.
    const now = new Date('2026-11-10T18:30:00Z')
    assert.equal(isCronDue('0 9 * * *', now, new Date('2026-11-09T04:36:00Z'), { lookbackMinutes: 26 * 60 }), true)
    assert.equal(isCronDue('0 9 * * *', now, null, { lookbackMinutes: 26 * 60 }), true)
  })

  it('does not run the same slot twice', () => {
    const now = new Date('2026-11-10T18:30:00Z')
    // ran at 09:04 today, after the 09:00 instant
    assert.equal(isCronDue('0 9 * * *', now, new Date('2026-11-10T09:04:00Z'), { lookbackMinutes: 26 * 60 }), false)
    // ran at 08:00 today, before the instant, so the 09:00 slot is still owed
    assert.equal(isCronDue('0 9 * * *', now, new Date('2026-11-10T08:00:00Z'), { lookbackMinutes: 26 * 60 }), true)
  })

  it('looks back only as far as it is told', () => {
    const now = new Date('2026-11-10T18:30:00Z')
    // yesterday's 09:00 slot is older than a 9 hour window, so nothing is due
    assert.equal(isCronDue('0 9 * * *', now, new Date('2026-11-08T09:00:00Z'), { lookbackMinutes: 9 * 60 }), false)
  })

  it('resolves the most recent scheduled instant', () => {
    const spec = parseCron('0 9 * * *')
    assert.equal(
      lastScheduledInstant(spec, new Date('2026-11-10T18:30:00Z'), 26 * 60)?.toISOString(),
      '2026-11-10T09:00:00.000Z'
    )
    assert.equal(lastScheduledInstant(spec, new Date('2026-11-10T18:30:00Z'), 0), null)
  })
})

describe('a rate-limited step waits instead of failing the run', () => {
  it("reads the wait the provider asked for", async () => {
    const { retryDelayMs, isRateLimitError } = await import('../src/agents/retry.js')
    assert.equal(retryDelayMs('Rate limit reached ... Please try again in 12s.'), 12_250)
    assert.equal(retryDelayMs('Please try again in 0.5s'), 750)
    assert.equal(retryDelayMs('retry-after: 3'), 3_250)
    assert.equal(retryDelayMs('no idea'), null)
    assert.equal(isRateLimitError('Rate limit reached for model'), true)
    assert.equal(isRateLimitError('429 Too Many Requests'), true)
    assert.equal(isRateLimitError('model not found'), false)
  })

  it('retries a rate limit and returns the successful attempt', async () => {
    const { callWithRateLimitRetry } = await import('../src/agents/retry.js')
    const slept: number[] = []
    let calls = 0
    const result = await callWithRateLimitRetry(
      async () => {
        calls++
        if (calls === 1) throw new Error('Rate limit reached. Please try again in 12s.')
        return 'ok'
      },
      { sleep: async (ms) => { slept.push(ms) } }
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 2)
    assert.deepEqual(slept, [12_250])
  })

  it('gives up rather than queueing past the function lifetime', async () => {
    const { callWithRateLimitRetry } = await import('../src/agents/retry.js')
    let calls = 0
    await assert.rejects(
      () => callWithRateLimitRetry(async () => { calls++; throw new Error('Rate limit reached. Please try again in 20s.') },
        { sleep: async () => {} }),
      /Rate limit/
    )
    assert.equal(calls, 2, 'two 20s waits exceed the 25s budget, so it stops there')
  })

  it('does not retry a failure that is not a rate limit', async () => {
    const { callWithRateLimitRetry } = await import('../src/agents/retry.js')
    let calls = 0
    await assert.rejects(
      () => callWithRateLimitRetry(async () => { calls++; throw new Error('model gpt-5 is not in the catalog') },
        { sleep: async () => {} }),
      /not in the catalog/
    )
    assert.equal(calls, 1)
  })
})
