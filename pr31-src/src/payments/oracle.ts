import type { TokenConfig } from './chains.js'

export type OracleQuote = {
  priceUsd: number
  liquidityUsd: number
  source: string
  /** True when the price is an ops-published rate, so no market-depth floor applies. */
  policy?: boolean
}

/**
 * Live USD price for a non-stable deposit token.
 * Uses GeckoTerminal's token endpoint, which reports the deepest pool's price
 * and the total reserve across pools.
 */
export async function getTokenPriceUsd(token: TokenConfig): Promise<OracleQuote | null> {
  const cfg = token.oracle
  if (!cfg) return null

  // Ops-published rate for our own token. Deliberately not a market read: the token's
  // only pool is one we run, so pricing credit off it would be circular. The deposit cap
  // is the guard here, not a liquidity floor.
  if (cfg.provider === 'policy') {
    const rate = Number(cfg.usdPerToken)
    if (!Number.isFinite(rate) || rate <= 0) return null
    return { priceUsd: rate, liquidityUsd: 0, source: 'policy', policy: true }
  }

  if (cfg.provider !== 'geckoterminal' || !cfg.network) return null

  const url = `https://api.geckoterminal.com/api/v2/networks/${cfg.network}/tokens/${token.address}`
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) return null
  const body: any = await res.json().catch(() => null)
  const attrs = body?.data?.attributes
  if (!attrs) return null

  const priceUsd = Number(attrs.price_usd)
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null

  // reserve_in_usd on the token endpoint is not exposed; derive liquidity from pools
  let liquidityUsd = 0
  try {
    const poolsRes = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${cfg.network}/tokens/${token.address}/pools`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    )
    if (poolsRes.ok) {
      const pools: any = await poolsRes.json().catch(() => null)
      for (const p of pools?.data ?? []) {
        const liq = Number(p?.attributes?.reserve_in_usd ?? 0)
        if (Number.isFinite(liq)) liquidityUsd += liq
      }
    }
  } catch {
    /* liquidity unknown -> treated as 0, caller refuses */
  }

  return { priceUsd, liquidityUsd, source: 'geckoterminal' }
}
