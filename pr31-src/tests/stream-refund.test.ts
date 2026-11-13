import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refundSplit, splitKeyCredit } from '../src/lib/keycredit.js'

test('a refund follows the same split the charge used', () => {
  // Key had plenty: reserve came wholly from key credit, so the whole overage returns to the key.
  const charge = splitKeyCredit(1_000_000, 30)
  const refund = refundSplit(10, charge.fromKey)
  assert.deepEqual(refund, { toKey: 10, toAccount: 0 })

  // Key had 4 micros and the reserve was 30: 4 from key, 26 from account.
  const mixed = splitKeyCredit(4, 30)
  assert.deepEqual(mixed, { fromKey: 4, fromAccount: 26 })
  assert.deepEqual(refundSplit(10, mixed.fromKey), { toKey: 4, toAccount: 6 })

  // No key involvement at all: everything goes back to the account.
  assert.deepEqual(refundSplit(10, 0), { toKey: 0, toAccount: 10 })

  // Guards: never refund more than was overcharged, never a negative amount.
  assert.deepEqual(refundSplit(5, 99), { toKey: 5, toAccount: 0 })
  assert.deepEqual(refundSplit(-5, 10), { toKey: 0, toAccount: 0 })
})
