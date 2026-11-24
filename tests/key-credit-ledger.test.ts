if (!process.env.DATABASE_URL) {
  process.env.PGLITE_MODE = '1'
  process.env.PGLITE_DIR = 'memory://'
}

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query } = await import('../src/db/index.js')
const { creditKey, debitKey, getKeyCreditMicros, chargeCall } = await import('../src/lib/keycredit.js')
const { measurePeriod } = await import('../src/lib/profit.js')

const ownerId = 'key_credit_ledger_owner'
const keyId = 'key_credit_ledger_probe'

describe('API-key credit subledger', () => {
  before(async () => {
    await migrate()
    await query(
      'INSERT INTO users (id, wallet, role) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
      [ownerId, '0x00000000000000000000000000000000000000aa', 'user']
    )
    await query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, credit_usd_micros)
       VALUES ($1,$2,'key ledger probe','hash','sk-thirdeye-probe',0)
       ON CONFLICT (id) DO NOTHING`,
      [keyId, ownerId]
    )
    const existingCredit = await getKeyCreditMicros(keyId)
    if (existingCredit > 0) await debitKey(keyId, existingCredit, 'test-reset-before-suite')
  })

  it('records verified deposits, usage and refunds with matching balances', async () => {
    const before = await measurePeriod('2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z')
    assert.equal(await creditKey(keyId, 1_000, { kind: 'deposit', ref: 'base:deposit-1' }), 1_000)
    assert.equal(await debitKey(keyId, 300, 'req:call-1'), 300)
    assert.equal(await creditKey(keyId, 50, { kind: 'refund', ref: 'refund:call-1' }), 750)
    assert.equal(await getKeyCreditMicros(keyId), 750)

    const rows = await query(
      `SELECT kind, amount_usd_micros, ref FROM api_key_credit_ledger
        WHERE api_key_id = $1 AND ref IN ('base:deposit-1', 'req:call-1', 'refund:call-1') ORDER BY id`,
      [keyId]
    )
    assert.deepEqual(rows.rows.map((r: any) => [r.kind, Number(r.amount_usd_micros), r.ref]), [
      ['deposit', 1_000, 'base:deposit-1'],
      ['usage', -300, 'req:call-1'],
      ['refund', 50, 'refund:call-1'],
    ])
    assert.equal(rows.rows.reduce((n: number, r: any) => n + Number(r.amount_usd_micros), 0), await getKeyCreditMicros(keyId))
    const after = await measurePeriod('2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z')
    assert.equal(after.api_key_credit_usd_micros - before.api_key_credit_usd_micros, 750)
    assert.equal(after.api_key_credit_ledger_drift_usd_micros, 0)
  })

  it('settles a key-tagged on-chain deposit into the key subledger atomically', async () => {
    const { creditDeposit } = await import('../src/lib/billing.js')
    const existingCredit = await getKeyCreditMicros(keyId)
    if (existingCredit > 0) await debitKey(keyId, existingCredit, 'test-reset-before-deposit')
    const txHash = '0x' + randomUUID().replace(/-/g, '').padEnd(64, '0')
    const result = await creditDeposit(ownerId, 500, { chain: 'base', txHash, token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }, { toKeyId: keyId })
    assert.equal(result.credited, true)
    assert.equal(result.keyCredit, 500)
    const rows = await query('SELECT kind, amount_usd_micros, ref FROM api_key_credit_ledger WHERE api_key_id = $1 AND ref = $2', [keyId, `base:${txHash}`])
    assert.deepEqual(rows.rows.map((r: any) => [r.kind, Number(r.amount_usd_micros), r.ref]), [
      ['deposit', 500, `base:${txHash}`],
    ])
    const measured = await measurePeriod('2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z')
    assert.equal(measured.api_key_credit_ledger_drift_usd_micros, 0)
  })

  it('refunds key credit atomically when the owner account cannot cover the remainder', async () => {
    const existingCredit = await getKeyCreditMicros(keyId)
    if (existingCredit > 0) await debitKey(keyId, existingCredit, 'test-reset-before-refund')
    await creditKey(keyId, 100, { kind: 'deposit', ref: 'base:deposit-2' })
    const before = await getKeyCreditMicros(keyId)
    const result = await chargeCall(keyId, ownerId, 200, 'req:charge-failed')
    assert.equal(result.ok, false)
    assert.equal(await getKeyCreditMicros(keyId), before)
    const rows = await query(
      `SELECT kind, amount_usd_micros FROM api_key_credit_ledger
        WHERE api_key_id = $1 AND ref IN ('req:charge-failed', 'refund:req:charge-failed') ORDER BY id`,
      [keyId]
    )
    assert.deepEqual(rows.rows.map((r: any) => [r.kind, Number(r.amount_usd_micros)]), [
      ['usage', -100],
      ['refund', 100],
    ])
  })

  it('serializes concurrent key spends so the same credit is never used twice', async () => {
    const existingCredit = await getKeyCreditMicros(keyId)
    if (existingCredit > 0) await debitKey(keyId, existingCredit, 'test-reset-before-race')
    await creditKey(keyId, 100, { kind: 'adjust', ref: 'race-opening' })
    const [a, b] = await Promise.all([debitKey(keyId, 80, 'race-a'), debitKey(keyId, 80, 'race-b')])
    assert.equal(a + b, 80)
    assert.equal(await getKeyCreditMicros(keyId), 20)
  })
})
