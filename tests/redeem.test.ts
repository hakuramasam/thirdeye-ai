import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkRedeemRequest,
  minPayoutRaw,
  isQuoteExpired,
  redeemPolicyFromEnv,
  type RedeemPolicy,
} from '../src/payments/redeem.js'

const policy: RedeemPolicy = {
  enabled: true,
  minUsdMicros: 5_000_000,
  maxPerCallMicros: 50_000_000,
  maxPerDayMicros: 100_000_000,
  slippageBps: 150,
  quoteTtlSeconds: 600,
  market: { minLiquidityUsd: 0, minVolume24hUsd: 0, maxPriceImpactBps: 0, maxAutoConvertUsd: 0 } as any,
}

const base = { balanceMicros: 40_000_000, dailySpentMicros: 0, policy }

test('a disabled deployment refuses before it looks at anything else', () => {
  const r = checkRedeemRequest({ ...base, amountUsdMicros: 10_000_000, policy: { ...policy, enabled: false } })
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'redeem_disabled')
})

test('the smallest redemption is enforced, and the boundary is inclusive', () => {
  const under = checkRedeemRequest({ ...base, amountUsdMicros: 4_999_999 })
  assert.equal(under.ok, false)
  assert.equal((under as any).code, 'below_minimum')

  assert.equal(checkRedeemRequest({ ...base, amountUsdMicros: 5_000_000 }).ok, true)
})

test('a single redemption cannot exceed the per-call cap', () => {
  const r = checkRedeemRequest({ ...base, amountUsdMicros: 50_000_001, balanceMicros: 100_000_000 })
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'above_per_call_cap')
})

test('the daily ceiling counts what was already spent today', () => {
  const r = checkRedeemRequest({ ...base, amountUsdMicros: 20_000_000, dailySpentMicros: 85_000_000, balanceMicros: 500_000_000 })
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'daily_cap_reached')
  // 15.00 left out of a 100.00 ceiling is stated, not left for the caller to work out.
  assert.match((r as any).message, /\$15\.00/)
})

test('spending exactly the remaining daily allowance is allowed', () => {
  assert.equal(
    checkRedeemRequest({ ...base, amountUsdMicros: 15_000_000, dailySpentMicros: 85_000_000, balanceMicros: 500_000_000 }).ok,
    true
  )
})

test('credits are checked last, and a shortfall is refused rather than overdrawn', () => {
  const r = checkRedeemRequest({ ...base, amountUsdMicros: 20_000_000, balanceMicros: 19_999_999 })
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'insufficient_credits')
})

test('zero, negative and fractional micros are refused as malformed', () => {
  for (const amount of [0, -1, 1.5]) {
    const r = checkRedeemRequest({ ...base, amountUsdMicros: amount })
    assert.equal(r.ok, false)
    assert.equal((r as any).code, 'invalid_amount')
  }
})

test('a valid request passes', () => {
  assert.equal(checkRedeemRequest({ ...base, amountUsdMicros: 5_000_000 }).ok, true)
})

test('the payout floor applies slippage against the quote, in the right direction', () => {
  // 150 bps off 1000 leaves 985, not 1015: the floor protects the user, not the platform.
  assert.equal(minPayoutRaw(1000n, 150), 985n)
  assert.equal(minPayoutRaw(1_000_000n, 0), 1_000_000n)
})

test('the floor never rounds a payout away entirely', () => {
  // Even a nonsensical 100% slippage param keeps 10% of the quote rather than zero.
  assert.equal(minPayoutRaw(1000n, 20_000), 100n)
  assert.equal(minPayoutRaw(0n, 150), 0n)
})

test('expiry is advisory but still measurable', () => {
  const now = new Date('2026-11-10T12:00:00Z')
  assert.equal(isQuoteExpired('2026-11-10T12:05:00Z', now), false)
  assert.equal(isQuoteExpired('2026-11-10T11:55:00Z', now), true)
  assert.equal(isQuoteExpired('not a date', now), true)
})

test('redemptions are off unless a deployment opts in', () => {
  assert.equal(redeemPolicyFromEnv({}).enabled, false)
  assert.equal(redeemPolicyFromEnv({ REDEEM_ENABLED: 'true' }).enabled, true)
  // Anything other than an explicit true stays off.
  assert.equal(redeemPolicyFromEnv({ REDEEM_ENABLED: 'yes' }).enabled, false)
})

test('caps are read in dollars and stored in micros', () => {
  const p = redeemPolicyFromEnv({ REDEEM_MIN_USD: '3', REDEEM_MAX_USD_PER_CALL: '25', REDEEM_MAX_USD_PER_DAY: '80' })
  assert.equal(p.minUsdMicros, 3_000_000)
  assert.equal(p.maxPerCallMicros, 25_000_000)
  assert.equal(p.maxPerDayMicros, 80_000_000)
})

test('a garbage cap falls back to the default instead of disabling the guard', () => {
  const p = redeemPolicyFromEnv({ REDEEM_MAX_USD_PER_DAY: 'lots' })
  assert.equal(p.maxPerDayMicros, 100_000_000)
})
