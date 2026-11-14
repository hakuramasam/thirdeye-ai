process.env.PGLITE_DIR = 'memory://'

/**
 * Settlement integrity regressions (WO-02 review).
 *
 * Each case below reproduces a defect found reviewing PR #41, and fails against that branch:
 *
 *  1. `recordPayment` returned a freshly generated id on a duplicate, so every later
 *     `UPDATE payments ... WHERE id = $1` matched nothing and the row stayed creditable forever.
 *  2. `markCredited` was an unconditional UPDATE, so a stale retry could overwrite `reorged` or
 *     `needs_reconciliation` with `credited`.
 *  3. `paymentStateFor` / `markReorged` looked a payment up by (chain, tx) without the token or the
 *     receiving wallet, which are part of the table's UNIQUE key, so one deposit's state could
 *     govern another's.
 *  4. The state change and its audit event were separate commits, so an event-write failure left a
 *     credited payment with no audit record, and a zero-row transition still wrote an event.
 *  5. A key-tagged deposit credited through `creditKey`, a bare increment with no idempotency, so
 *     each retry added the amount again.
 *  6. A receipt with no block number was read as block 0, which made any head look final.
 *  7. `decideSettlement` fail-opened on any state it did not recognise.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const { markCredited, markReorged, paymentStateFor, paymentRowFor } = await import('../src/payments/settle.js')
const { decideSettlement, finalityVerdict, finalityPolicy } = await import('../src/payments/finality.js')
const { recordPayment } = await import('../src/routes/credits.js')
const { creditDeposit } = await import('../src/lib/billing.js')

const CHAIN = 8453
const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TX = '0x' + 'a'.repeat(64)
const VAULT = 'treasury_vault'
const WALLET = 'agent_wallet'

let owner: any
let keyId: string

function transfer(over: Partial<any> = {}) {
  return {
    chain_id: CHAIN,
    tx_hash: TX,
    token: TOKEN,
    from: '0x' + '1'.repeat(40),
    to: '0x' + '2'.repeat(40),
    raw_amount: '5000000',
    decimals: 6,
    registered: true,
    block_number: 100,
    confirmations: 12,
    required_confirmations: 10,
    ...over,
  }
}

/** A payment row as the claim route would write it. */
async function claim(over: Partial<any> = {}, args: Partial<any> = {}) {
  return recordPayment({
    intent: null,
    userId: owner.id,
    transfer: transfer(over),
    receivedAt: args.receivedAt ?? VAULT,
    usdMicros: args.usdMicros ?? 5_000_000,
    status: args.status ?? 'recorded',
    refusalCode: null,
    state: args.state ?? 'confirmed',
    confirmations: 12,
    observedBlock: 100,
    ...args,
  })
}

async function eventsFor(paymentId: string, kind: string) {
  const rows = await query(`SELECT * FROM payment_events WHERE payment_id = $1 AND kind = $2`, [paymentId, kind])
  return rows.rows
}

describe('settlement integrity', () => {
  before(async () => {
    await migrate()
    owner = { id: randomUUID(), wallet: '0x' + '3'.repeat(40) }
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, 'user')`, [owner.id, owner.wallet])
    keyId = 'key_' + randomUUID().slice(0, 8)
    await query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES ($1, $2, 'test', $3, 'sk-thirdeye-Test')`,
      [keyId, owner.id, randomUUID().replace(/-/g, '')]
    )
  })

  it('a duplicate claim returns the row that exists, not a new id', async () => {
    const first = await claim()
    assert.equal(first.duplicate, false)

    const second = await claim()
    assert.equal(second.duplicate, true, 'the second claim must be recognised as a replay')
    assert.equal(second.paymentId, first.paymentId, 'a replay must address the existing row')

    // And the row that replay addresses is really there, which is what made markCredited a no-op.
    const row = await one(`SELECT id, state FROM payments WHERE id = $1`, [second.paymentId])
    assert.ok(row, 'the returned id must match a stored payment')
  })

  it('a duplicate claim does not create a second record', async () => {
    await claim({ tx_hash: '0x' + 'b'.repeat(64) })
    const before = await one(`SELECT count(*)::int AS n FROM payments WHERE user_id = $1`, [owner.id])
    await claim({ tx_hash: '0x' + 'b'.repeat(64) })
    const after = await one(`SELECT count(*)::int AS n FROM payments WHERE user_id = $1`, [owner.id])
    assert.equal(after.n, before.n)
  })

  it('markCredited credits once, promotes the row and its intent, and writes one event', async () => {
    const intentId = 'pin_' + randomUUID().slice(0, 8)
    await query(
      `INSERT INTO payment_intents (id, user_id, purpose, expected_usd_micros, expires_at)
       VALUES ($1, $2, 'api_credits', 5000000, now() + interval '30 minutes')`,
      [intentId, owner.id]
    )
    const payment = await recordPayment({
      intent: { id: intentId },
      userId: owner.id,
      transfer: transfer({ tx_hash: '0x' + 'c'.repeat(64) }),
      receivedAt: VAULT,
      usdMicros: 5_000_000,
      status: 'pending_confirmations',
      refusalCode: null,
      state: 'confirming',
      confirmations: 3,
      observedBlock: 100,
    })

    const rec = await markCredited(payment.paymentId, 5_000_000)
    assert.equal(rec.credited, true)
    assert.equal(rec.state, 'credited')

    const row = await one(`SELECT state, status, credited_at FROM payments WHERE id = $1`, [payment.paymentId])
    assert.equal(row.state, 'credited')
    assert.equal(row.status, 'recorded', 'a credited deposit must stop reading as pending_confirmations')
    assert.ok(row.credited_at, 'the credit time is recorded')

    const intent = await one(`SELECT status FROM payment_intents WHERE id = $1`, [intentId])
    assert.equal(intent.status, 'paid', 'a credited deposit settles its intent')

    assert.equal((await eventsFor(payment.paymentId, 'credited')).length, 1)

    // A replay is a no-op: no second credit, no second event.
    const again = await markCredited(payment.paymentId, 5_000_000)
    assert.equal(again.credited, false)
    assert.equal((await eventsFor(payment.paymentId, 'credited')).length, 1)
  })

  it('concurrent credits of the same payment produce exactly one credited event', async () => {
    const payment = await claim({ tx_hash: '0x' + 'd'.repeat(64) })
    const results = await Promise.all([
      markCredited(payment.paymentId, 5_000_000),
      markCredited(payment.paymentId, 5_000_000),
      markCredited(payment.paymentId, 5_000_000),
    ])
    assert.equal(results.filter((r) => r.credited).length, 1, 'only one caller may move the row')
    assert.equal((await eventsFor(payment.paymentId, 'credited')).length, 1)
  })

  it('markCredited cannot overwrite a reorg finding', async () => {
    const payment = await claim({ tx_hash: '0x' + 'e'.repeat(64) })
    const reorg = await markReorged(CHAIN, '0x' + 'e'.repeat(64))
    assert.equal(reorg?.state, 'reorged')
    assert.equal(reorg?.wasCredited, false, 'nothing was credited, so nothing needs reconciling')

    const rec = await markCredited(payment.paymentId, 5_000_000)
    assert.equal(rec.credited, false, 'a reorged payment must never be reported as credited')
    const row = await one(`SELECT state FROM payments WHERE id = $1`, [payment.paymentId])
    assert.notEqual(row.state, 'credited', 'the reorg finding survives a stale credit attempt')
    assert.equal((await eventsFor(payment.paymentId, 'credited')).length, 0, 'a refused transition writes no event')
  })

  it('markCredited cannot overwrite the reconciliation flag', async () => {
    const payment = await claim({ tx_hash: '0x' + 'f'.repeat(64) })
    await query(`UPDATE payments SET state = 'needs_reconciliation' WHERE id = $1`, [payment.paymentId])
    const rec = await markCredited(payment.paymentId, 5_000_000)
    assert.equal(rec.credited, false)
    assert.equal(rec.reconciliation, true, 'the caller must be told this needs a human')
    const row = await one(`SELECT state FROM payments WHERE id = $1`, [payment.paymentId])
    assert.equal(row.state, 'needs_reconciliation')
  })

  it('a credit that lands on an already-reorged deposit is escalated, not reversed', async () => {
    // The race the guard cannot prevent: the money is credited, then the chain drops the deposit.
    const payment = await claim({ tx_hash: '0x' + '9'.repeat(64) })
    await query(`UPDATE payments SET state = 'reorged' WHERE id = $1`, [payment.paymentId])

    const rec = await markCredited(payment.paymentId, 5_000_000)
    assert.equal(rec.credited, false)
    assert.equal(rec.reconciliation, true)
    const row = await one(`SELECT state FROM payments WHERE id = $1`, [payment.paymentId])
    assert.equal(row.state, 'needs_reconciliation', 'credited-then-reorged waits for authorized reconciliation')
    assert.equal((await eventsFor(payment.paymentId, 'reconciliation_required')).length, 1)
    // No ledger reversal was attempted: that is a financial action, not a retry.
    const ledger = await one(
      `SELECT count(*)::int AS n FROM ledger WHERE user_id = $1 AND kind = 'reversal'`,
      [owner.id]
    )
    assert.equal(ledger.n, 0)
  })

  it('a repeat reorg check keeps the stronger finding', async () => {
    const payment = await claim({ tx_hash: '0x' + '8'.repeat(64) })
    await query(`UPDATE payments SET state = 'needs_reconciliation' WHERE id = $1`, [payment.paymentId])
    const again = await markReorged(CHAIN, '0x' + '8'.repeat(64))
    assert.equal(again?.wasCredited, true, 'a reorged credited deposit is still reported as credited')
    assert.equal(again?.state, 'needs_reconciliation')
    const row = await one(`SELECT state FROM payments WHERE id = $1`, [payment.paymentId])
    assert.equal(row.state, 'needs_reconciliation', 'a repeat check must not downgrade the finding')
  })

  it('payment lookups are scoped to the receiving wallet, not just chain and tx', async () => {
    const tx = '0x' + '7'.repeat(64)
    const inVault = await claim({ tx_hash: tx }, { receivedAt: VAULT })
    const inWallet = await claim({ tx_hash: tx }, { receivedAt: WALLET, state: 'confirming' })

    assert.notEqual(inVault.paymentId, inWallet.paymentId, 'one tx can pay two receivers: two rows')

    const want = { chain_id: CHAIN, tx_hash: tx, token: TOKEN, received_by: WALLET }
    assert.equal(await paymentStateFor(want), 'confirming', 'the wallet row answers for the wallet')
    assert.equal(
      await paymentStateFor({ ...want, received_by: VAULT }),
      'confirmed',
      'the vault row keeps its own state'
    )
    assert.equal(
      await paymentStateFor({ ...want, received_by: 'automation_account' }),
      null,
      'a receiver with no row must not inherit another wallet\'s state'
    )

    // Scoping the reorg check keeps it on the deposit that vanished.
    const reorg = await markReorged(CHAIN, tx, { received_by: WALLET, token: TOKEN })
    assert.equal(reorg?.paymentId, inWallet.paymentId)
    const vaultRow = await one(`SELECT state FROM payments WHERE id = $1`, [inVault.paymentId])
    assert.equal(vaultRow.state, 'confirmed', 'the untouched deposit keeps its state')
  })

  it('a key-tagged deposit credits its key once, however often it is claimed', async () => {
    const args = { chain: 'base', txHash: '0x' + '6'.repeat(64), token: TOKEN }
    const first = await creditDeposit(owner.id, 2_000_000, args, { toKeyId: keyId })
    assert.equal(first.credited, true)

    const second = await creditDeposit(owner.id, 2_000_000, args, { toKeyId: keyId })
    assert.equal(second.credited, false, 'the deposits row is the replay guard')

    const key = await one(`SELECT credit_usd_micros FROM api_keys WHERE id = $1`, [keyId])
    assert.equal(Number(key.credit_usd_micros), 2_000_000, 'the key was loaded exactly once')

    const rows = await one(`SELECT count(*)::int AS n FROM deposits WHERE tx_hash = $1`, [args.txHash])
    assert.equal(rows.n, 1)
  })

  it('a receipt with no block number is never final', async () => {
    const verdict = finalityVerdict({ chainId: CHAIN, receiptBlock: null, headBlock: 1_000_000n, env: {} })
    assert.equal(verdict.state, 'confirming', 'an unverifiable receipt must not clear the gate')
    assert.equal(verdict.confirmations, 0)
    assert.equal(verdict.unverifiable, 'missing_receipt_block')
    assert.equal(verdict.observedBlock, null)

    const undef = finalityVerdict({ chainId: CHAIN, receiptBlock: undefined, headBlock: 1_000_000n, env: {} })
    assert.equal(undef.state, 'confirming')
  })

  it('an unreadable head block cannot confirm a transfer', async () => {
    const verdict = finalityVerdict({ chainId: CHAIN, receiptBlock: 500n, headBlock: 0n, env: {} })
    assert.equal(verdict.confirmations, 0)
    assert.equal(verdict.state, 'confirming')
  })

  it('depth counts the receipt block as the first confirmation', async () => {
    const one_deep = finalityVerdict({ chainId: CHAIN, receiptBlock: 500n, headBlock: 500n, env: {} })
    assert.equal(one_deep.confirmations, 1)
    assert.equal(one_deep.state, 'confirming')
    const ten_deep = finalityVerdict({ chainId: CHAIN, receiptBlock: 500n, headBlock: 509n, env: {} })
    assert.equal(ten_deep.confirmations, 10)
    assert.equal(ten_deep.state, 'confirmed')
    // Behind the receipt is zero, never negative.
    assert.equal(finalityVerdict({ chainId: CHAIN, receiptBlock: 500n, headBlock: 499n, env: {} }).confirmations, 0)
  })

  it('the confirmation requirement cannot be lowered to zero by junk configuration', async () => {
    for (const raw of ['', ' ', '0', '0.5', '-3', 'soon', '1e3', 'NaN']) {
      const policy = finalityPolicy(CHAIN, { FINALITY_CONFIRMATIONS_BASE: raw })
      assert.equal(
        policy.minConfirmations,
        10,
        `"${raw}" must fall back to the chain default, not disable the gate`
      )
      assert.equal(policy.source, 'default')
    }
    const real = finalityPolicy(CHAIN, { FINALITY_CONFIRMATIONS_BASE: ' 4 ' })
    assert.equal(real.minConfirmations, 4)
    assert.equal(real.source, 'env')
  })

  it('settlement refuses a state it does not recognise', async () => {
    const decisions = ['processing', 'converted', 'pending', '', 'REORGED'].map((state) =>
      decideSettlement({ state, confirmations: 100, required: 10 })
    )
    for (const d of decisions) {
      assert.equal(d.action, 'refuse', 'an unknown state must not fall through to a credit')
      assert.equal((d as any).reason, 'needs_reconciliation')
    }
    assert.deepEqual(decideSettlement({ state: 'credited', confirmations: 100, required: 10 }), {
      action: 'already_credited',
    })
    assert.equal(decideSettlement({ state: 'confirmed', confirmations: 10, required: 10 }).action, 'credit')
    assert.equal(decideSettlement({ state: 'confirming', confirmations: 3, required: 10 }).action, 'wait')
  })

  it('a refused deposit is stored as rejected and can never be credited later', async () => {
    const refused = await claim({ tx_hash: '0x' + '5'.repeat(64) }, { status: 'refused', state: 'rejected', usdMicros: 0 })
    const state = await paymentStateFor({
      chain_id: CHAIN,
      tx_hash: '0x' + '5'.repeat(64),
      token: TOKEN,
      received_by: VAULT,
    })
    assert.equal(state, 'rejected')
    assert.equal(decideSettlement({ state, confirmations: 100, required: 10 }).action, 'refuse')
    const rec = await markCredited(refused.paymentId, 5_000_000)
    assert.equal(rec.credited, false)
  })

  it('every state transition leaves an audit record the ledger can be reconciled against', async () => {
    const payment = await claim({ tx_hash: '0x' + '4'.repeat(64) })
    await markCredited(payment.paymentId, 5_000_000)
    const credited = await eventsFor(payment.paymentId, 'credited')
    assert.equal(credited.length, 1)
    assert.equal(Number(credited[0].detail.usd_micros), 5_000_000, 'the event carries the amount credited')

    // A transition that matched no row writes nothing, so the log never claims work that did not
    // happen.
    const ghost = await markCredited('pay_does_not_exist', 1)
    assert.equal(ghost.credited, false)
    assert.equal(ghost.state, null)
  })
})
