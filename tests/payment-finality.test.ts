import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  confirmationsFor,
  decideSettlement,
  finalityPolicy,
  finalityVerdict,
} from '../src/payments/finality.js'
import { formatRawAmount, rawAmountToNumber } from '../src/lib/money.js'

// ── Policy ───────────────────────────────────────────────────────────────────

test('finality policy is conservative by default and per chain', () => {
  assert.equal(finalityPolicy(8453, {}).minConfirmations, 10)
  assert.equal(finalityPolicy(56, {}).minConfirmations, 15)
  assert.equal(finalityPolicy(4663, {}).minConfirmations, 10)
  // An unknown chain still gets a floor rather than crediting instantly.
  assert.equal(finalityPolicy(999, {}).minConfirmations, 12)
  assert.equal(finalityPolicy(999, {}).source, 'default')
})

test('the requirement is overridable from the environment, and junk is ignored', () => {
  assert.equal(finalityPolicy(8453, { FINALITY_CONFIRMATIONS_BASE: '3' }).minConfirmations, 3)
  assert.equal(finalityPolicy(8453, { FINALITY_CONFIRMATIONS_BASE: '3' }).source, 'env')
  assert.equal(finalityPolicy(8453, { FINALITY_CONFIRMATIONS_BASE: '0' }).minConfirmations, 0)
  // Anything unparseable or negative must not silently lower the gate.
  assert.equal(finalityPolicy(8453, { FINALITY_CONFIRMATIONS_BASE: 'soon' }).minConfirmations, 10)
  assert.equal(finalityPolicy(8453, { FINALITY_CONFIRMATIONS_BASE: '-5' }).minConfirmations, 10)
})

test('confirmations count block depth, and an unreadable head is zero rather than assumed', () => {
  assert.equal(confirmationsFor(100n, 100n), 1)
  assert.equal(confirmationsFor(100n, 109n), 10)
  assert.equal(confirmationsFor(100n, 99n), 0)
  assert.equal(confirmationsFor(0, 0), 1)
})

test('a receipt one block deep is confirming, not confirmed', () => {
  const shallow = finalityVerdict({ chainId: 8453, receiptBlock: 500n, headBlock: 500n, env: {} })
  assert.equal(shallow.state, 'confirming')
  assert.equal(shallow.confirmations, 1)
  assert.equal(shallow.required, 10)

  const deep = finalityVerdict({ chainId: 8453, receiptBlock: 500n, headBlock: 509n, env: {} })
  assert.equal(deep.state, 'confirmed')
  assert.equal(deep.confirmations, 10)
  assert.equal(deep.observedBlock, 500)
})

// ── Settlement decisions ─────────────────────────────────────────────────────

test('nothing is credited before finality', () => {
  const d = decideSettlement({ state: 'confirming', confirmations: 3, required: 10 })
  assert.equal(d.action, 'wait')
  assert.equal(d.action === 'wait' && d.reason, 'insufficient_confirmations')
})

test('a final, uncredited payment settles, which is how a retry completes', () => {
  for (const state of ['detected', 'confirming', 'confirmed', undefined, null]) {
    const d = decideSettlement({ state: state as any, confirmations: 12, required: 10 })
    assert.equal(d.action, 'credit', `state ${state} should settle once final`)
  }
})

test('an already credited payment is never credited twice', () => {
  assert.equal(decideSettlement({ state: 'credited', confirmations: 99, required: 10 }).action, 'already_credited')
})

test('a reorged or reconciled payment is refused, not retried', () => {
  for (const state of ['reorged', 'rejected', 'needs_reconciliation']) {
    const d = decideSettlement({ state, confirmations: 99, required: 10 })
    assert.equal(d.action, 'refuse')
    assert.equal(d.action === 'refuse' && d.reason, state)
  }
})

// ── Exact money maths ────────────────────────────────────────────────────────

test('raw token amounts survive the conversion that Number() would corrupt', () => {
  // 1e21 raw units at 18 decimals is 1000 tokens: Number(raw) is exact here, 1e18*7 is not.
  assert.equal(formatRawAmount(10n ** 21n, 18), '1000')
  assert.equal(formatRawAmount(1n, 18), '0.000000000000000001')
  assert.equal(formatRawAmount(0n, 18), '0')
  assert.equal(formatRawAmount(123456789n, 6), '123.456789')

  // The case that motivated this: an 18-decimal amount past 2^53.
  const big = 7_000_000_000_000_000_001n
  assert.equal(formatRawAmount(big, 18), '7.000000000000000001')
  assert.notEqual(Number(big).toString(), '7000000000000000001')
  assert.equal(rawAmountToNumber(big, 18), 7)
  assert.deepEqual(formatRawAmount(12345n, 2), '123.45')
  assert.equal(rawAmountToNumber(12345n, 2), 123.45)
})

test('implausible decimals are refused rather than guessed', () => {
  assert.throws(() => formatRawAmount(1n, -1))
  assert.throws(() => formatRawAmount(1n, 37))
  assert.throws(() => formatRawAmount(1n, 1.5))
})

// ── Wiring guards ────────────────────────────────────────────────────────────

test('the claim route gates on finality and handles a reorg', () => {
  const route = readFileSync(new URL('../src/routes/credits.ts', import.meta.url), 'utf8')
  assert.match(route, /finality\.state === 'confirming'/, 'payment-review must not credit a shallow receipt')
  assert.match(route, /pending_confirmations/, 'a shallow receipt must be recorded as confirming')
  assert.match(route, /decideSettlement\(/, 'settling must go through the state machine')
  assert.match(route, /markReorged\(/, 'a vanished transaction must be detected as a reorg')
  assert.match(route, /reorg_detected/, 'a reorg must be reported as such')
  assert.equal(
    /shouldCreditPayment\(\{ status: 'recorded', duplicate: recorded\.duplicate/.test(route),
    false,
    'the duplicate-blind credit gate must be gone'
  )
})

test('the schema persists settlement state and an append-only event log', () => {
  const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8')
  for (const column of ['state text NOT NULL DEFAULT', 'confirmations integer', 'observed_block bigint', 'credited_at timestamptz', 'reconciled_at timestamptz']) {
    assert.ok(schema.includes(column), `payments should persist ${column}`)
  }
  assert.match(schema, /CREATE TABLE IF NOT EXISTS payment_events/)
  assert.match(schema, /kind\s+text NOT NULL/)
})
