/**
 * Tradability analysis for deposits paid in arbitrary ERC-20 tokens.
 *
 * A deposit token is only accepted when it can actually be turned into the
 * settlement stablecoin at a price we can defend: a real pool must exist, it
 * must carry depth and recent volume, the deposit itself must not be a
 * meaningful share of that depth, and a transfer into the platform wallet must
 * not revert.
 *
 * The lesson this encodes: a quoted price is not a price you can realise.
 * A pool with zero 24h volume and thin reserves can show a $15.9k valuation on
 * a token that no router will fill.
 */

export type RefusalCode =
  | 'unsupported_chain'
  | 'analysis_unavailable'
  | 'no_pool'
  | 'price_unavailable'
  | 'liquidity_too_low'
  | 'volume_too_low'
  | 'price_impact_too_high'
  | 'amount_too_large'
  | 'transfer_reverts'
  | 'amount_not_positive'

export type MarketPolicy = {
  minLiquidityUsd: number
  minVolume24hUsd: number
  maxPriceImpactBps: number
  maxAutoConvertUsd: number
}

export const DEFAULT_MARKET_POLICY: MarketPolicy = {
  minLiquidityUsd: 25_000,
  minVolume24hUsd: 1_000,
  maxPriceImpactBps: 300,
  maxAutoConvertUsd: 500,
}

export type MarketAnalysis =
  | {
      tradable: true
      priceUsd: number
      liquidityUsd: number
      volume24hUsd: number
      amountUsd: number
      impactBps: number
      poolAddress: string
      dex: string
      source: string
    }
  | {
      tradable: false
      code: RefusalCode
      message: string
      priceUsd?: number
      liquidityUsd?: number
      volume24hUsd?: number
      amountUsd?: number
      impactBps?: number
    }

/** GeckoTerminal network slug for the chains we settle on. */
const NETWORK_SLUG: Record<number, string> = {
  8453: 'base',
  4663: 'robinhood', // may not be indexed; refusal is explicit rather than silent
}

export type PoolCandidate = {
  address: string
  dex: string
  reserveUsd: number
  volume24hUsd: number
  priceUsd: number
}

/** Pick the deepest pool: depth decides whether a swap can clear. */
export function pickDeepestPool(pools: PoolCandidate[]): PoolCandidate | null {
  const usable = pools.filter((p) => Number.isFinite(p.reserveUsd) && p.reserveUsd > 0 && p.priceUsd > 0)
  if (usable.length === 0) return null
  return usable.sort((a, b) => b.reserveUsd - a.reserveUsd)[0]
}

/**
 * Price impact estimate for a constant-product style pool: the deposit's share
 * of the pool's depth, in basis points. Deliberately conservative — it is a
 * refusal gate, not a trading model.
 */
export function estimateImpactBps(amountUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return Number.MAX_SAFE_INTEGER
  return Math.round((amountUsd / liquidityUsd) * 10_000)
}

export function evaluateMarket(params: {
  amountUsd: number
  pool: PoolCandidate | null
  policy?: Partial<MarketPolicy>
}): MarketAnalysis {
  const policy = { ...DEFAULT_MARKET_POLICY, ...(params.policy ?? {}) }
  const { amountUsd, pool } = params

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { tradable: false, code: 'amount_not_positive', message: 'Deposit amount is zero or unreadable' }
  }
  if (!pool) {
    return { tradable: false, code: 'no_pool', message: 'No pool with usable liquidity was found for this token' }
  }
  if (pool.reserveUsd < policy.minLiquidityUsd) {
    return {
      tradable: false,
      code: 'liquidity_too_low',
      message: `Pool depth $${Math.round(pool.reserveUsd)} is below the $${policy.minLiquidityUsd} floor`,
      priceUsd: pool.priceUsd,
      liquidityUsd: pool.reserveUsd,
      volume24hUsd: pool.volume24hUsd,
      amountUsd,
    }
  }
  if (pool.volume24hUsd < policy.minVolume24hUsd) {
    return {
      tradable: false,
      code: 'volume_too_low',
      message: `24h volume $${Math.round(pool.volume24hUsd)} is below the $${policy.minVolume24hUsd} floor, so a quote is untestable`,
      priceUsd: pool.priceUsd,
      liquidityUsd: pool.reserveUsd,
      volume24hUsd: pool.volume24hUsd,
      amountUsd,
    }
  }
  if (amountUsd > policy.maxAutoConvertUsd) {
    return {
      tradable: false,
      code: 'amount_too_large',
      message: `Deposit $${amountUsd.toFixed(2)} exceeds the $${policy.maxAutoConvertUsd} auto-convert ceiling; needs manual review`,
      priceUsd: pool.priceUsd,
      liquidityUsd: pool.reserveUsd,
      volume24hUsd: pool.volume24hUsd,
      amountUsd,
    }
  }
  const impactBps = estimateImpactBps(amountUsd, pool.reserveUsd)
  if (impactBps > policy.maxPriceImpactBps) {
    return {
      tradable: false,
      code: 'price_impact_too_high',
      message: `Deposit would move the pool by ~${impactBps} bps, above the ${policy.maxPriceImpactBps} bps limit`,
      priceUsd: pool.priceUsd,
      liquidityUsd: pool.reserveUsd,
      volume24hUsd: pool.volume24hUsd,
      amountUsd,
      impactBps,
    }
  }

  return {
    tradable: true,
    priceUsd: pool.priceUsd,
    liquidityUsd: pool.reserveUsd,
    volume24hUsd: pool.volume24hUsd,
    amountUsd,
    impactBps,
    poolAddress: pool.address,
    dex: pool.dex,
    source: 'geckoterminal',
  }
}

/** Read pools for a token from GeckoTerminal and analyse tradability. */
export async function analyseToken(params: {
  chainId: number
  tokenAddress: string
  amountRaw: bigint
  decimals: number
  policy?: Partial<MarketPolicy>
}): Promise<MarketAnalysis> {
  const network = NETWORK_SLUG[params.chainId]
  if (!network) {
    return { tradable: false, code: 'unsupported_chain', message: `Chain ${params.chainId} is not supported for token deposits` }
  }
  let pools: any = null
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${params.tokenAddress}/pools`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    )
    if (!res.ok) {
      return { tradable: false, code: 'analysis_unavailable', message: `Market data unavailable (HTTP ${res.status})` }
    }
    pools = await res.json()
  } catch (e: any) {
    return { tradable: false, code: 'analysis_unavailable', message: `Market data request failed: ${String(e?.message || e).slice(0, 120)}` }
  }

  const wanted = params.tokenAddress.toLowerCase()
  // Only pools where our token is the BASE token: base_token_price_usd then means
  // "price of our token". In a WETH/USDC pool the same field is the price of WETH,
  // which would mis-price a deposit by three orders of magnitude.
  const candidates: PoolCandidate[] = (pools?.data ?? [])
    .filter((p: any) => {
      const baseId = String(p?.relationships?.base_token?.data?.id ?? '').toLowerCase()
      return baseId.endsWith(wanted.replace(/^0x/, ''))
    })
    .map((p: any) => ({
      address: String(p?.attributes?.address ?? ''),
      dex: String(p?.relationships?.dex?.data?.id ?? ''),
      reserveUsd: Number(p?.attributes?.reserve_in_usd ?? 0),
      volume24hUsd: Number(p?.attributes?.volume_usd?.h24 ?? 0),
      priceUsd: Number(p?.attributes?.base_token_price_usd ?? 0),
    }))

  const pool = pickDeepestPool(candidates)
  if (!pool) {
    return { tradable: false, code: 'no_pool', message: 'No indexed pool for this token' }
  }
  const amountTokens = Number(params.amountRaw) / 10 ** params.decimals
  const amountUsd = amountTokens * pool.priceUsd
  return evaluateMarket({ amountUsd, pool, policy: params.policy })
}
