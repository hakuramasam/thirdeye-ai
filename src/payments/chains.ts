import { env } from '../lib/env.js'

export type TokenConfig = {
  symbol: string
  address: string
  decimals: number
  /** Stablecoins are valued 1:1 with USD. Defaults to true. */
  stable?: boolean
  /** Pricing rules for non-stable deposit tokens. */
  oracle?: {
    provider: 'geckoterminal'
    /** GeckoTerminal network slug, e.g. 'base' */
    network: string
    /** Refuse deposits when pool liquidity (USD) is below this. */
    minLiquidityUsd: number
    /** Max USD value accepted in a single deposit. */
    maxDepositUsd: number
    /** Credit discount applied to the oracle price, in basis points. */
    haircutBps: number
  }
}

export type ChainConfig = {
  id: string
  name: string
  chainId: number
  rpc: string
  tokens: TokenConfig[]
}

export const CHAINS: ChainConfig[] = [
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    rpc: 'https://mainnet.base.org',
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
    ],
  },
  {
    id: 'robinhood',
    name: 'Robinhood Chain',
    chainId: 4663,
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
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
  base.tokens.push({
    symbol: env.platformTokenSymbol,
    address: env.platformTokenAddress,
    decimals: env.platformTokenDecimals,
    stable: false,
    oracle: {
      provider: 'geckoterminal',
      network: 'base',
      minLiquidityUsd: env.platformTokenMinLiquidityUsd,
      maxDepositUsd: env.platformTokenMaxDepositUsd,
      haircutBps: 0, // platform token deposits earn the bonus instead of a haircut
    },
  })
}

registerPlatformToken()
