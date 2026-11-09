import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isNativeAsset,
  nativeRail,
  privyEnvFromEnv,
  quoteNativeSwap,
  toMicros,
} from '../src/payments/nativeSwap.js'
import { prepareAutoConvert, autoConvertPolicyFromEnv } from '../src/payments/autoConvert.js'

const policy = autoConvertPolicyFromEnv({ ...process.env, AUTO_CONVERT_ENABLED: 'true' } as any)

test('native ETH and BNB are recognised however the caller spells them', () => {
  for (const spelling of ['0x0000000000000000000000000000000000000000', 'native', 'NATIVE', '', 'eth']) {
    assert.equal(isNativeAsset(8453, spelling), true, `Base should treat "${spelling}" as native`)
  }
  for (const spelling of ['0x0000000000000000000000000000000000000000', 'native', '', 'bnb']) {
    assert.equal(isNativeAsset(56, spelling), true, `BSC should treat "${spelling}" as native`)
  }
})

test('an ERC-20 is never mistaken for a native asset', () => {
  assert.equal(isNativeAsset(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), false)
  assert.equal(isNativeAsset(56, '0x55d398326f99059fF775485246999027B3197955'), false)
  // Robinhood has no native rail plumbed yet, so even the zero address must not claim one.
  assert.equal(isNativeAsset(4663, '0x0000000000000000000000000000000000000000'), false)
})

test('each rail names the stablecoin that chain settles in', () => {
  const base = nativeRail(8453)!
  assert.equal(base.symbol, 'ETH')
  assert.equal(base.caip2, 'eip155:8453')
  assert.equal(base.settlement.symbol, 'USDC')
  assert.equal(base.settlement.decimals, 6)
  const bsc = nativeRail(56)!
  assert.equal(bsc.symbol, 'BNB')
  assert.equal(bsc.caip2, 'eip155:56')
  assert.equal(bsc.settlement.symbol, 'USDT')
  assert.equal(bsc.settlement.decimals, 18, 'BSC USDT is 18 decimals, unlike Base USDC')
  assert.equal(nativeRail(999), null)
})

test('micro-dollar scaling respects each stablecoin decimals', () => {
  assert.equal(toMicros(2_500_000n, 6), 2_500_000)
  // 1.5 USDT at 18 decimals is 1.5 dollars, i.e. 1_500_000 micros.
  assert.equal(toMicros(1_500_000_000_000_000_000n, 18), 1_500_000)
  assert.equal(toMicros(0n, 18), 0)
  assert.equal(toMicros(150n, 2), 1_500_000)
})

test('the native rail refuses cleanly when Privy is not configured', async () => {
  // Clear the ambient values for the duration of the call: with credentials present this
  // would reach out and quote for real, which is not what this test is about.
  const saved = { id: process.env.PRIVY_APP_ID, secret: process.env.PRIVY_APP_SECRET, wallet: process.env.PRIVY_WALLET_ID }
  delete process.env.PRIVY_APP_ID
  delete process.env.PRIVY_APP_SECRET
  delete process.env.PRIVY_WALLET_ID
  try {
    const quote = await quoteNativeSwap({ chainId: 8453, amountRaw: 10n ** 15n })
    assert.equal(quote.ok, false)
    assert.equal((quote as any).code, 'privy_not_configured')
  } finally {
    for (const [k, v] of [['PRIVY_APP_ID', saved.id], ['PRIVY_APP_SECRET', saved.secret], ['PRIVY_WALLET_ID', saved.wallet]] as const) {
      if (v !== undefined) process.env[k] = v
    }
  }
})

test('privyEnvFromEnv stays silent until all three wallet values exist', () => {
  assert.equal(privyEnvFromEnv({} as any), null)
  assert.equal(privyEnvFromEnv({ PRIVY_APP_ID: 'a', PRIVY_APP_SECRET: 'b' } as any), null)
  const full = privyEnvFromEnv({ PRIVY_APP_ID: 'a', PRIVY_APP_SECRET: 'b', PRIVY_WALLET_ID: 'c' } as any)
  assert.equal(full?.walletId, 'c')
})

test('a native deposit is priced by the swap engine that will convert it', async () => {
  const prepared = await prepareAutoConvert({
    chainId: 8453,
    tokenAddress: '0x0000000000000000000000000000000000000000',
    amountRaw: 10n ** 16n, // 0.01 ETH
    decimals: 18,
    policy,
    deps: {
      quoteNative: async () => ({ ok: true, estOutAmount: 21_074_929n, minimumOutAmount: 20_548_056n, gasEstimate: null }),
    },
  })
  assert.equal(prepared.ok, true)
  const ok = prepared as Extract<typeof prepared, { ok: true }>
  assert.equal(ok.settlementToken, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  assert.ok(Math.abs(ok.analysis.amountUsd - 21.074929) < 0.000001, 'value comes from the quote, not the pool')
  assert.equal(ok.analysis.dex, 'privy')
})

test('a native deposit is refused when the engine has no route', async () => {
  const prepared = await prepareAutoConvert({
    chainId: 56,
    tokenAddress: 'native',
    amountRaw: 10n ** 16n,
    decimals: 18,
    policy,
    deps: {
      quoteNative: async () => ({ ok: false, code: 'native_no_route', message: 'no route' }),
    },
  })
  assert.equal(prepared.ok, false)
  assert.equal((prepared as any).code, 'native_no_route')
})

test('a native deposit above the auto-credit ceiling is refused before any swap', async () => {
  const prepared = await prepareAutoConvert({
    chainId: 8453,
    tokenAddress: 'native',
    amountRaw: 10n ** 18n,
    decimals: 18,
    policy,
    deps: {
      // 0.5 ETH at ~$2100 would be ~$1050, well over the $500 ceiling.
      quoteNative: async () => ({ ok: true, estOutAmount: 1_050_000_000n, minimumOutAmount: 1_000_000_000n, gasEstimate: null }),
    },
  })
  assert.equal(prepared.ok, false)
  assert.equal((prepared as any).code, 'amount_too_large')
})
