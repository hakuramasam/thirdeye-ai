process.env.PGLITE_DIR = 'memory://'
// Set before the env module loads: chains.ts registers the platform token at import time.
process.env.PLATFORM_TOKEN_ADDRESS = '0xA8A65A86E01D227Dbfd7C7a94d14344b33603df5'
process.env.PLATFORM_TOKEN_SYMBOL = 'THIRDEYE'
process.env.PLATFORM_TOKEN_DECIMALS = '18'
process.env.PLATFORM_TOKEN_BONUS_BPS = '1000'
process.env.PLATFORM_TOKEN_MAX_DEPOSIT_USD = '25'
process.env.PLATFORM_TOKEN_USD_RATE = '0.00008'

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Dynamic imports on purpose: static ones are hoisted above the process.env setup above,
// which would leave the platform token unregistered.
const { CHAINS, getChain, isPlatformToken, isPolicyPricedToken, platformTokenUsdMicros } =
  await import('../src/payments/chains.js')
const { getTokenPriceUsd } = await import('../src/payments/oracle.js')
const { decideCredit } = await import('../src/lib/creditPolicy.js')

const THIRDEYE = '0xA8A65A86E01D227Dbfd7C7a94d14344b33603df5'

test('the platform token is registered on Base as a deposit token', () => {
  const base = getChain('base')!
  const token = base.tokens.find((t) => t.address.toLowerCase() === THIRDEYE.toLowerCase())
  assert.ok(token, 'THIRDEYE must be a registered deposit token')
  assert.equal(token.symbol, 'THIRDEYE')
  assert.equal(token.decimals, 18)
  assert.equal(token.stable, false)
  assert.equal(token.oracle?.provider, 'policy')
  assert.equal(token.oracle?.maxDepositUsd, 25)
  assert.equal(token.oracle?.bonusBps, 1000)
})

test('the platform token is never priced off the curve we run', async () => {
  const base = getChain('base')!
  const token = base.tokens.find((t) => t.address.toLowerCase() === THIRDEYE.toLowerCase())!
  const quote = await getTokenPriceUsd(token)
  assert.ok(quote, 'a published rate must produce a price')
  assert.equal(quote.source, 'policy')
  assert.equal(quote.policy, true)
  assert.equal(quote.priceUsd, 0.00008)
})

test('the policy rate is the rate, and the bonus is applied on top', () => {
  // 100,000 THIRDEYE at $0.00008 = $8.00, plus the 10% bonus = $8.80.
  assert.equal(platformTokenUsdMicros(100_000n * 10n ** 18n, 18), 8_800_000)
})

test('policy pricing is only claimed for the platform token', () => {
  assert.equal(isPlatformToken(THIRDEYE), true)
  assert.equal(isPolicyPricedToken(THIRDEYE), true)
  const trend = getChain('base')!.tokens.find((t) => t.symbol === 'TREND')!
  assert.equal(isPolicyPricedToken(trend.address), false)
})

test('platform-token deposits are credited without a swap, other volatile tokens are not', () => {
  const platform = decideCredit({
    chainSlug: 'base',
    token: THIRDEYE,
    oracleMicros: 8_800_000,
    policyPriced: true,
  })
  assert.equal(platform.status, 'credited')
  assert.equal(platform.creditMicros, 8_800_000)

  const other = decideCredit({
    chainSlug: 'base',
    token: '0xbf981cfF5040F9652D4721c85C3e05F6d79f9b07',
    oracleMicros: 8_800_000,
  })
  assert.equal(other.status, 'pending_conversion')
  assert.equal(other.creditMicros, 0)
})

test('no rate published means no credit, not a guess', async () => {
  // Simulate the pre-launch state by pricing a token with no policy rate.
  const unpriced = {
    symbol: 'THIRDEYE',
    address: THIRDEYE,
    decimals: 18,
    stable: false,
    oracle: { provider: 'policy' as const, usdPerToken: 0, maxDepositUsd: 25, haircutBps: 0 },
  }
  assert.equal(await getTokenPriceUsd(unpriced), null)
  assert.equal(CHAINS.length > 0, true)
})
