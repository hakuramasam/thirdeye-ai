process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

const { migrate, query, one } = await import('../src/db/index.js')
const { createApiKey, monthStart } = await import('../src/lib/keys.js')
const { checkKeyBudget, chargeKeyBudget } = await import('../src/lib/keybudget.js')
import type { ApiKeyRow } from '../src/lib/types.js'

async function freshUser(wallet: string) {
  const row = await one(
    `INSERT INTO users (id, wallet, role) VALUES ($1,$2,'user') RETURNING id, wallet, role`,
    ['u_' + Math.random().toString(36).slice(2, 10), wallet]
  )
  return row
}

describe('Per-key monthly budget caps', () => {
  before(async () => {
    await migrate()
  })

  it('uncapped key reports unlimited remaining and never exhausts', async () => {
    const u = await freshUser('0xaaa0000000000000000000000000000000000001')
    const { row } = await createApiKey(u.id, 'uncapped', 60, 250000, null)
    const state = await checkKeyBudget(row as any)
    assert.equal(state.cap, null)
    assert.equal(state.exhausted, false)
    assert.equal(state.remaining, Infinity)
  })

  it('caps spending at the monthly budget', async () => {
    const u = await freshUser('0xaaa0000000000000000000000000000000000002')
    const CAP = 1000
    const { row } = await createApiKey(u.id, 'capped', 60, 250000, CAP)
    const key = row as any

    let state = await checkKeyBudget(key)
    assert.equal(state.cap, CAP)
    assert.equal(state.spent, 0)
    assert.equal(state.exhausted, false)

    await chargeKeyBudget(key, 400)
    const reloaded = (await one('SELECT * FROM api_keys WHERE id = $1', [key.id])) as any
    state = await checkKeyBudget(reloaded)
    assert.equal(state.spent, 400)
    assert.equal(state.remaining, 600)
    assert.equal(state.exhausted, false)

    await chargeKeyBudget(reloaded, 600)
    const full = (await one('SELECT * FROM api_keys WHERE id = $1', [key.id])) as any
    state = await checkKeyBudget(full)
    assert.equal(state.spent, 1000)
    assert.equal(state.exhausted, true)
  })

  it("rolls the period forward on a new month, resetting spend", async () => {
    const u = await freshUser('0xaaa0000000000000000000000000000000000003')
    const { row } = await createApiKey(u.id, 'rolled', 60, 250000, 500)
    const key = row as any
    await chargeKeyBudget(key, 500)

    // simulate last month's period
    await query(`UPDATE api_keys SET period_start = $1 WHERE id = $2`, [
      new Date(Date.UTC(2020, 0, 1)).toISOString(),
      key.id,
    ])
    const stale = (await one('SELECT * FROM api_keys WHERE id = $1', [key.id])) as any
    const state = await checkKeyBudget(stale)
    assert.equal(state.spent, 0)
    assert.equal(state.exhausted, false)
    assert.equal(state.cap, 500)

    const after = (await one('SELECT period_start FROM api_keys WHERE id = $1', [key.id])) as any
    assert.equal(new Date(after.period_start).toISOString(), monthStart())
  })

  it('charges nothing for zero-cost or uncapped calls', async () => {
    const u = await freshUser('0xaaa0000000000000000000000000000000000004')
    const { row } = await createApiKey(u.id, 'nocharge', 60, 250000, null)
    await chargeKeyBudget(row as any, 999)
    const after = (await one('SELECT period_spent_usd_micros FROM api_keys WHERE id = $1', [(row as any).id])) as any
    assert.equal(Number(after.period_spent_usd_micros), 0)
  })
})
