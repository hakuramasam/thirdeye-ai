export type TokenConfig = {
  symbol: string
  address: string
  decimals: number
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
