process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTokenStatus, availabilityAt, nextUnlock, scheduleStatus } from '../src/payments/tokenStatus.js'
import { PREMINT_SCHEDULES } from '../src/data/tokenSchedules.js'

const S = PREMINT_SCHEDULES
const base = {
  symbol: 'THIRDEYE', address: '0xa8a65a86e01d227dbfd7c7a94d14344b33603df5', decimals: 18,
  supply: 1_000_000_000, premintHeld: 800_000_000,
  poolAddress: '0x6309d838712108206856c9ce1ab743c8f50863b9b4c4389c828fe1c950256066', poolLocked: true,
  priceUsd: 0.0000884, priceEth: 4.824e-8, priceSource: 'geckoterminal', schedules: S,
  fees: { pendingWeth: 0, lastCollectedWeth: 0, block: 58_561_002, at: '2026-11-17T08:05:00Z' },
}

test('nothing is releasable before a cliff', () => {
  const now = new Date('2026-11-18T00:00:00Z')
  for (const s of S) assert.equal(availabilityAt(s, now), 0, s.label)
})

test('at a cliff that equals its end, the whole bucket becomes available', () => {
  const s = S.find((x) => x.label === 'promo and platform airdrops')!
  assert.equal(s.cliffEnd, s.end, 'this bucket unlocks at its cliff')
  assert.equal(availabilityAt(s, new Date(Date.parse(s.cliffEnd) - 60_000)), 0)
  assert.equal(availabilityAt(s, new Date(s.cliffEnd)), s.amount)
})

test('a linear schedule is proportional to elapsed time once past its cliff', () => {
  const s = { id: 'x', label: 'x', amount: 100, start: '2026-01-01T00:00:00Z', cliffEnd: '2026-01-11T00:00:00Z', end: '2026-01-21T00:00:00Z' }
  assert.equal(availabilityAt(s, new Date('2026-01-05T00:00:00Z')), 0)
  assert.equal(availabilityAt(s, new Date('2026-01-11T00:00:00Z')), 50)
  assert.equal(availabilityAt(s, new Date('2026-01-31T00:00:00Z')), 100)
})

test('the next unlock is the soonest cliff still in the future, and names its schedule', () => {
  const now = new Date('2026-11-18T00:00:00Z')
  const nx = nextUnlock(S.map((s) => scheduleStatus(s, now)), now)
  assert.ok(nx)
  assert.equal(nx!.at, '2026-12-12T06:03:24.000Z')
  assert.equal(nx!.amount, 110_000_000)
  assert.ok(nx!.in_days > 20 && nx!.in_days < 27, String(nx!.in_days))
})

test('a status with a price states FDV, and one without states why instead of zero', () => {
  const priced = computeTokenStatus({ ...base, now: new Date('2026-11-18T00:00:00Z') })
  assert.equal(priced.valuation.fdv_usd, 0.0000884 * 1_000_000_000)
  assert.equal(priced.valuation.unavailable_reason, null)
  const unpriced = computeTokenStatus({ ...base, priceUsd: null, priceSource: null, now: new Date('2026-11-18T00:00:00Z') })
  assert.equal(unpriced.valuation.fdv_usd, null)
  assert.equal(unpriced.valuation.price_usd, null)
  assert.equal(unpriced.valuation.unavailable_reason, 'no_market_read')
})

test('held minus available is what is still locked, and nothing is released yet', () => {
  const st = computeTokenStatus({ ...base, now: new Date('2026-11-18T00:00:00Z') })
  assert.equal(st.premint.total, 800_000_000)
  assert.equal(st.premint.available_now, 0)
  assert.equal(st.premint.locked_now, 800_000_000)
  assert.equal(st.premint.released, 0)
})
