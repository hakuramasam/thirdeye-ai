import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldCreditPayment, chainSlugFor } from '../src/routes/credits.js'

test('a first-time tradable payment credits', () => {
  assert.equal(shouldCreditPayment({ status: 'recorded', duplicate: false, usdMicros: 4_970_000 }), true)
})

test('a refused payment never credits, even with a value attached', () => {
  assert.equal(shouldCreditPayment({ status: 'refused', duplicate: false, usdMicros: 4_970_000 }), false)
})

test('a replay of the same transfer never credits twice', () => {
  assert.equal(shouldCreditPayment({ status: 'recorded', duplicate: true, usdMicros: 4_970_000 }), false)
})

test('a recorded payment worth zero credits nothing', () => {
  assert.equal(shouldCreditPayment({ status: 'recorded', duplicate: false, usdMicros: 0 }), false)
  assert.equal(shouldCreditPayment({ status: 'recorded', duplicate: false, usdMicros: -1 }), false)
})

test('chain ids map to the deposit ledger slugs', () => {
  assert.equal(chainSlugFor(8453), 'base')
  assert.equal(chainSlugFor(56), 'bsc')
  assert.equal(chainSlugFor(4663), 'robinhood')
  assert.equal(chainSlugFor(1), null)
})
