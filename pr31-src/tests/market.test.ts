import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMarket, estimateImpactBps, pickDeepestPool, DEFAULT_MARKET_POLICY } from '../src/payments/market.js'
import { autoConvertPolicyFromEnv, netCreditMicros } from '../src/payments/autoConvert.js'
import { minOutFromPrice, settlementTokenFor } from '../src/payments/swap.js'

const goodPool = { address: '0xpool', dex: 'uniswap-v4-base', reserveUsd: 500_000, volume24hUsd: 50_000, priceUsd: 0.5 }

test('a deep, traded pool accepts a small deposit', () => {
  const r = evaluateMarket({ amountUsd: 25, pool: goodPool })
  assert.equal(r.tradable, true)
  if (r.tradable) {
    assert.equal(r.impactBps, 1) // $25 into $500k
    assert.equal(r.poolAddress, '0xpool')
  }
})

test('zero 24h volume is refused even when depth looks healthy', () => {
  const r = evaluateMarket({ amountUsd: 8, pool: { ...goodPool, reserveUsd: 100_000, volume24hUsd: 0 } })
  assert.equal(r.tradable, false)
  if (!r.tradable) assert.equal(r.code, 'volume_too_low')
})

test('the TREND shape is refused: $15.9k depth fails the liquidity floor first', () => {
  const r = evaluateMarket({ amountUsd: 8, pool: { ...goodPool, reserveUsd: 15_950, volume24hUsd: 0 } })
  assert.equal(r.tradable, false)
  if (!r.tradable) assert.equal(r.code, 'liquidity_too_low')
})

test('thin depth is refused before volume is even considered', () => {
  const r = evaluateMarket({ amountUsd: 5, pool: { ...goodPool, reserveUsd: 4_000 } })
  assert.equal(r.tradable, false)
  if (!r.tradable) assert.equal(r.code, 'liquidity_too_low')
})

test('a deposit that would move the pool is refused', () => {
  const r = evaluateMarket({
    amountUsd: 400,
    pool: { reserveUsd: 10_000, volume24hUsd: 9_000, priceUsd: 1, address: '0xp', dex: 'd' },
    policy: { minLiquidityUsd: 1_000, minVolume24hUsd: 100 },
  })
  assert.equal(r.tradable, false)
  if (!r.tradable) assert.equal(r.code, 'price_impact_too_high') // 400 bps into 10k
})

test('oversized deposits need manual review rather than a bigger swap', () => {
  const r = evaluateMarket({ amountUsd: 5_000, pool: goodPool })
  assert.equal(r.tradable, false)
  if (!r.tradable) assert.equal(r.code, 'amount_too_large')
})

test('missing pool, zero amount and bad numbers are explicit refusals', () => {
  assert.equal((evaluateMarket({ amountUsd: 10, pool: null }) as any).code, 'no_pool')
  assert.equal((evaluateMarket({ amountUsd: 0, pool: goodPool }) as any).code, 'amount_not_positive')
  assert.equal((evaluateMarket({ amountUsd: Number.NaN, pool: goodPool }) as any).code, 'amount_not_positive')
})

test('policy thresholds are overridable per call', () => {
  const r = evaluateMarket({ amountUsd: 10, pool: { ...goodPool, reserveUsd: 10_000, volume24hUsd: 100 }, policy: { minLiquidityUsd: 5_000, minVolume24hUsd: 50 } })
  assert.equal(r.tradable, true)
})

test('deepest pool wins, junk pools are ignored', () => {
  const picked = pickDeepestPool([
    { address: 'small', dex: 'd', reserveUsd: 1_000, volume24hUsd: 10, priceUsd: 1 },
    { address: 'deep', dex: 'd', reserveUsd: 900_000, volume24hUsd: 5, priceUsd: 1 },
    { address: 'zero', dex: 'd', reserveUsd: 0, volume24hUsd: 0, priceUsd: 0 },
  ])
  assert.equal(picked?.address, 'deep')
  assert.equal(pickDeepestPool([]), null)
})

test('impact estimate is proportional share of depth in bps', () => {
  assert.equal(estimateImpactBps(100, 100_000), 10)
  assert.equal(estimateImpactBps(0, 0), Number.MAX_SAFE_INTEGER)
})

test('env policy defaults are safe and parsing is strict', () => {
  const p = autoConvertPolicyFromEnv({} as any)
  assert.equal(p.enabled, false) // off unless explicitly switched on
  assert.equal(p.minLiquidityUsd, DEFAULT_MARKET_POLICY.minLiquidityUsd)
  assert.equal(p.slippageBps, 100)
  const on = autoConvertPolicyFromEnv({ AUTO_CONVERT_ENABLED: 'true', AUTO_CONVERT_MAX_USD: '50' } as any)
  assert.equal(on.enabled, true)
  assert.equal(on.maxAutoConvertUsd, 50)
})

test('credit is the stablecoin received minus the platform fee, never negative', () => {
  assert.equal(netCreditMicros(1_000_000, { platformFeeBps: 0 }), 1_000_000)
  assert.equal(netCreditMicros(1_000_000, { platformFeeBps: 100 }), 990_000)
  assert.equal(netCreditMicros(-5, { platformFeeBps: 0 }), 0)
  assert.equal(netCreditMicros(Number.NaN, { platformFeeBps: 0 }), 0)
})

test('min-out applies slippage and cannot go negative', () => {
  assert.equal(minOutFromPrice(1_000_000n, 100), 990_000n)
  assert.equal(minOutFromPrice(1_000_000n, 20_000), 100_000n) // slippage clamped at 90%, so min-out stays positive
})

test('settlement token is USDC on Base and unset until USDG is configured on Robinhood', () => {
  assert.equal(settlementTokenFor(8453), '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  const prev = process.env.USDG_ROBINHOOD_ADDRESS
  delete process.env.USDG_ROBINHOOD_ADDRESS
  assert.equal(settlementTokenFor(4663), null)
  if (prev) process.env.USDG_ROBINHOOD_ADDRESS = prev
  assert.equal(settlementTokenFor(1), null)
})
