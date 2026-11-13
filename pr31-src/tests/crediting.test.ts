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

import { registeredStable } from '../src/payments/autoConvert.js'

test('registered stablecoins are recognised on their own chain', () => {
  // USDG on Robinhood Chain: the case that used to be refused for lack of an indexer.
  assert.equal(registeredStable(4663, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'), 'USDG')
  assert.equal(registeredStable(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), 'USDC')
  assert.equal(registeredStable(56, '0x55d398326f99059fF775485246999027B3197955'), 'USDT')
})

test('the settlement token counts even when not listed in tokens[]', () => {
  assert.equal(registeredStable(56, '0x55d398326f99059fF775485246999027B3197955', '0x55d398326f99059fF775485246999027B3197955'), 'USDT')
})

test('unknown and non-stable tokens are not treated as stable', () => {
  assert.equal(registeredStable(4663, '0x0000000000000000000000000000000000000001'), null)
  assert.equal(registeredStable(8453, '0xbf981cfF5040F9652D4721c85C3e05F6d79f9b07'), null) // TREND
})
