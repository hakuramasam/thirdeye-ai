/**
 * Auto-convert deposit tokens into the settlement stablecoin before crediting.
 *
 * Order of operations, deliberately:
 *   1. analysis  — is this token real, deep, traded, and small enough to fill?
 *   2. decision  — refuse with an explicit code, or proceed
 *   3. swap      — convert into USDC (Base) / USDG (Robinhood Chain)
 *   4. credit    — only the stablecoin actually received is credited
 *
 * Refusal is a first-class outcome. Nothing is credited on a quoted price.
 */

import { analyseToken, DEFAULT_MARKET_POLICY, type MarketPolicy } from './market.js'
import { settlementTokenFor, swapOnBase } from './swap.js'
import { CHAINS } from './chains.js'

export type AutoConvertPolicy = MarketPolicy & {
  enabled: boolean
  slippageBps: number
  platformFeeBps: number
}

export function autoConvertPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AutoConvertPolicy {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  return {
    enabled: String(env.AUTO_CONVERT_ENABLED ?? 'false').toLowerCase() === 'true',
    minLiquidityUsd: num(env.AUTO_CONVERT_MIN_LIQUIDITY_USD, DEFAULT_MARKET_POLICY.minLiquidityUsd),
    minVolume24hUsd: num(env.AUTO_CONVERT_MIN_VOLUME_24H_USD, DEFAULT_MARKET_POLICY.minVolume24hUsd),
    maxPriceImpactBps: num(env.AUTO_CONVERT_MAX_IMPACT_BPS, DEFAULT_MARKET_POLICY.maxPriceImpactBps),
    maxAutoConvertUsd: num(env.AUTO_CONVERT_MAX_USD, DEFAULT_MARKET_POLICY.maxAutoConvertUsd),
    slippageBps: num(env.AUTO_CONVERT_SLIPPAGE_BPS, 100),
    platformFeeBps: num(env.AUTO_CONVERT_FEE_BPS, 0),
  }
}

/** Net credit after conversion, fees and slippage buffer. Never negative. */
export function netCreditMicros(grossOutMicros: number, policy: Pick<AutoConvertPolicy, 'platformFeeBps'>): number {
  if (!Number.isFinite(grossOutMicros) || grossOutMicros <= 0) return 0
  const fee = Math.floor((grossOutMicros * policy.platformFeeBps) / 10_000)
  return Math.max(0, grossOutMicros - fee)
}

/** The registered symbol when this token is a stablecoin on that chain, else null. */
export function registeredStable(chainId: number, tokenAddress: string, settlement?: string | null): string | null {
  const addr = String(tokenAddress || '').toLowerCase()
  if (!addr) return null
  const cfg = CHAINS.find((c) => c.chainId === chainId)
  const token = cfg?.tokens.find((t) => t.address.toLowerCase() === addr)
  if (token && token.stable !== false) return token.symbol
  // The settlement stablecoin counts even if it was not listed in tokens[].
  const settle = settlement ?? settlementTokenFor(chainId)
  if (settle && settle.toLowerCase() === addr) return cfg?.settlement?.symbol ?? 'stablecoin'
  return null
}

export type PrepareResult =
  | {
      ok: true
      analysis: Extract<Awaited<ReturnType<typeof analyseToken>>, { tradable: true }>
      settlementToken: string
      note: string
    }
  | { ok: false; code: string; message: string }

/**
 * Decide whether a deposit token can be auto-converted, without moving funds.
 * This is what the deposit page and the credits path call first.
 */
export async function prepareAutoConvert(params: {
  chainId: number
  tokenAddress: string
  amountRaw: bigint
  decimals: number
  policy?: AutoConvertPolicy
}): Promise<PrepareResult> {
  const policy = params.policy ?? autoConvertPolicyFromEnv()
  if (!policy.enabled) {
    return { ok: false, code: 'auto_convert_disabled', message: 'Auto-convert is disabled; this token needs manual review' }
  }
  const settlement = settlementTokenFor(params.chainId)
  if (!settlement) {
    return { ok: false, code: 'unsupported_chain', message: `No settlement stablecoin configured for chain ${params.chainId}` }
  }
  // A stablecoin needs no market: it is already what we settle in, so it is
  // valued 1:1 and never swapped. This also covers chains with no price source
  // (Robinhood), where requiring an indexer price would refuse our own USDG.
  const stable = registeredStable(params.chainId, params.tokenAddress, settlement)
  if (stable) {
    const amountUsd = Number(params.amountRaw) / 10 ** params.decimals
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return { ok: false, code: 'amount_too_large', message: 'Payment value could not be determined from token decimals' }
    }
    if (amountUsd > policy.maxAutoConvertUsd) {
      return { ok: false, code: 'amount_too_large', message: `Payment of $${amountUsd.toFixed(2)} exceeds the $${policy.maxAutoConvertUsd} auto-credit ceiling` }
    }
    return {
      ok: true,
      analysis: {
        tradable: true,
        priceUsd: 1,
        liquidityUsd: 0,
        volume24hUsd: 0,
        amountUsd,
        impactBps: 0,
        poolAddress: 'none',
        dex: 'none',
        source: 'stablecoin-peg',
      },
      settlementToken: settlement,
      note: `Stablecoin payment in ${stable}, credited 1:1 with no swap`,
    }
  }

  const analysis = await analyseToken(params)
  if (!analysis.tradable) {
    return { ok: false, code: analysis.code, message: analysis.message }
  }
  return {
    ok: true,
    analysis,
    settlementToken: settlement,
    note: `Routes through ${analysis.dex} pool ${analysis.poolAddress} at ~$${analysis.amountUsd.toFixed(2)} subject to ${policy.slippageBps} bps slippage`,
  }
}

/** Execute the conversion for an accepted deposit. Returns stablecoin received. */
export async function executeAutoConvert(params: {
  chainId: number
  tokenAddress: string
  amountRaw: bigint
  decimals: number
  swapper: `0x${string}`
  policy?: AutoConvertPolicy
}): Promise<
  | { ok: true; outAmount: bigint; outToken: string; creditMicros: number; impactBps: number; pool: string }
  | { ok: false; code: string; message: string }
> {
  const policy = params.policy ?? autoConvertPolicyFromEnv()
  const prepared = await prepareAutoConvert(params)
  if (!prepared.ok) return prepared

  if (params.chainId !== 8453) {
    return { ok: false, code: 'swap_unavailable', message: `Auto-convert execution is implemented for Base only right now (chain ${params.chainId})` }
  }

  const swap = await swapOnBase({
    tokenIn: params.tokenAddress,
    amountIn: params.amountRaw,
    swapper: params.swapper,
    slippageBps: policy.slippageBps,
  })
  if (!swap.ok) return swap

  // USDC is 6 decimals, i.e. micro-dollars, so the raw output is the credit.
  const creditMicros = netCreditMicros(Number(swap.outAmount), policy)
  return {
    ok: true,
    outAmount: swap.outAmount,
    outToken: swap.outToken,
    creditMicros,
    impactBps: prepared.analysis.impactBps,
    pool: prepared.analysis.poolAddress,
  }
}
