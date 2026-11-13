import { env } from '../lib/env.js'

export type TokenConfig = {
  symbol: string
  address: string
  decimals: number
  /** Stablecoins are valued 1:1 with USD. Defaults to true. */
  stable?: boolean
  /** Pricing rules for non-stable deposit tokens. */
  oracle?: {
    /**
     * geckoterminal: price read from a public market, with a liquidity floor.
     * policy: an ops-published USD rate, for a token whose only market is one we
     * control (our own platform token). A market we own cannot price itself
     * honestly, so the rate is set deliberately and gated by the deposit cap.
     */
    provider: 'geckoterminal' | 'policy'
    /** GeckoTerminal network slug, e.g. 'base'. geckoterminal provider only. */
    network?: string
    /** Ops-published USD price per whole token. policy provider only. */
    usdPerToken?: number
    /** Refuse deposits when pool liquidity (USD) is below this. policy provider: unused. */
    minLiquidityUsd?: number
    /** Max USD value accepted in a single deposit. */
    maxDepositUsd: number
    /** Credit discount applied to the oracle price, in basis points. */
    haircutBps: number
    /** Credit premium added on top of the valued amount, in basis points (platform token perk). */
    bonusBps?: number
  }
}

export type ChainConfig = {
  id: string
  name: string
  chainId: number
  rpc: string
  /** GeckoTerminal network slug used to price non-stable deposit tokens. */
  gtNetwork: string
  /**
   * Stablecoin we convert payment tokens into before crediting. Anything we
   * cannot convert into this token is refused, so it must exist on the chain.
   */
  settlement: { symbol: string; address: string; decimals: number }
  tokens: TokenConfig[]
}

export const CHAINS: ChainConfig[] = [
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    rpc: 'https://mainnet.base.org',
    gtNetwork: 'base',
    settlement: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    tokens: [
      {
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        stable: true,
      },
      {
        // Trends Mining Simulator (TREND). Priced from its only market (Uniswap v4 TREND/WETH).
        // Illiquid by design: $5k liquidity floor, $25 cap per deposit, 10% credit haircut.
        symbol: 'TREND',
        address: '0xbf981cfF5040F9652D4721c85C3e05F6d79f9b07',
        decimals: 18,
        stable: false,
        oracle: {
          provider: 'geckoterminal',
          network: 'base',
          minLiquidityUsd: 5000,
          maxDepositUsd: 25,
          haircutBps: 1000,
        },
      },
      {
        // haku85 creator coin ($HAKU85). One contract answers to both spellings; there is no
        // separate HAKU85 token on Base. Its only market is a Uniswap v4 haku85/ZORA pool that
        // is far below the liquidity floor, so deposits are expected to be refused until it deepens.
        symbol: 'haku85',
        address: '0xf21ec85ce0b05640436ffd7e8fabba5d82eb0774',
        decimals: 18,
        stable: false,
        oracle: {
          provider: 'geckoterminal',
          network: 'base',
          minLiquidityUsd: 5000,
          maxDepositUsd: 25,
          haircutBps: 1000,
        },
      },
      {
        // AASA (Authorized Agentic Social Avatar). Only market is a Uniswap v4 AASA/METAc pool
        // with no 24h volume, so the same conservative deposit rules apply as for TREND.
        symbol: 'AASA',
        address: '0xb2000000000000000000001582178dd38a037f83',
        decimals: 18,
        stable: false,
        oracle: {
          provider: 'geckoterminal',
          network: 'base',
          minLiquidityUsd: 5000,
          maxDepositUsd: 25,
          haircutBps: 1000,
        },
      },
    ],
  },
  {
    id: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    rpc: 'https://bsc-dataseed.binance.org',
    gtNetwork: 'bsc',
    settlement: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    tokens: [
      {
        symbol: 'USDT',
        address: '0x55d398326f99059fF775485246999027B3197955',
        decimals: 18,
        stable: true,
      },
      {
        symbol: 'USDC',
        address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        decimals: 18,
        stable: true,
      },
    ],
  },
  {
    id: 'robinhood',
    name: 'Robinhood Chain',
    chainId: 4663,
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    gtNetwork: 'robinhood',
    settlement: { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
    tokens: [
      {
        symbol: 'USDG',
        address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        decimals: 6,
      },
    ],
  },
]

export function getChain(id: string): ChainConfig | undefined {
  return CHAINS.find((c) => c.id === id)
}


/**
 * Platform token (THIRDEYE) is registered at runtime from env, so the deposit
 * path works the moment the token is deployed and PLATFORM_TOKEN_ADDRESS is set.
 * It is oracle-priced: mint it, seed a pool, and deposits value themselves.
 */
export function registerPlatformToken(): void {
  if (!env.platformTokenAddress) return
  const base = CHAINS.find((c) => c.id === 'base')
  if (!base) return
  const exists = base.tokens.some((t) => t.address.toLowerCase() === env.platformTokenAddress)
  if (exists) return
  // Two ways to value our own token, chosen by whether an ops rate is published.
  // With a rate, deposits are priced by policy: the token's only market is a curve we
  // run, so a spot read off it would be circular (and, while the curve is one-sided,
  // unquotable in the sell direction anyway). Without a rate it falls back to a public
  // GeckoTerminal read, which refuses until the token has a real, deep market.
  const rate = Number(env.platformTokenUsdRate) || 0
  const oracle =
    rate > 0
      ? {
          provider: 'policy' as const,
          usdPerToken: rate,
          maxDepositUsd: env.platformTokenMaxDepositUsd,
          haircutBps: 0, // platform token deposits earn the bonus instead of a haircut
          bonusBps: env.platformTokenBonusBps,
        }
      : {
          provider: 'geckoterminal' as const,
          network: 'base',
          minLiquidityUsd: env.platformTokenMinLiquidityUsd,
          maxDepositUsd: env.platformTokenMaxDepositUsd,
          haircutBps: 0,
          bonusBps: env.platformTokenBonusBps,
        }
  base.tokens.push({
    symbol: env.platformTokenSymbol,
    address: env.platformTokenAddress,
    decimals: env.platformTokenDecimals,
    stable: false,
    oracle,
  })
}

/** True when this address is the platform token, valued by an ops-published rate. */
export function isPlatformToken(tokenAddress: string): boolean {
  if (!env.platformTokenAddress || !tokenAddress) return false
  return String(tokenAddress).toLowerCase() === env.platformTokenAddress
}

/**
 * Value a platform-token amount at the published policy rate, bonus included.
 * Returns null when no policy rate is published, so callers refuse rather than
 * credit an unvalued deposit.
 */
export function platformTokenUsdMicros(rawAmount: bigint, decimals: number): number | null {
  const base = CHAINS.find((c) => c.id === 'base')
  const token = base?.tokens.find((t) => t.address.toLowerCase() === env.platformTokenAddress)
  const cfg = token?.oracle
  if (!cfg || cfg.provider !== 'policy') return null
  const rate = Number(cfg.usdPerToken)
  if (!Number.isFinite(rate) || rate <= 0) return null
  const amount = Number(rawAmount) / 10 ** Number(decimals)
  const bonus = 1 + Number(cfg.bonusBps ?? 0) / 10_000
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * rate * bonus * 1_000_000)
}

/** True when the token is priced by ops policy rather than a public market. */
export function isPolicyPricedToken(tokenAddress: string): boolean {
  if (!isPlatformToken(tokenAddress)) return false
  const base = CHAINS.find((c) => c.id === 'base')
  const token = base?.tokens.find((t) => t.address.toLowerCase() === env.platformTokenAddress)
  return token?.oracle?.provider === 'policy'
}

registerPlatformToken()
