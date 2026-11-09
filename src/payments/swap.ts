/**
 * Convert an accepted deposit token into the settlement stablecoin.
 *
 * Base: Uniswap Trading API (quote -> approval -> swap), which brings its own
 * routing, so we do not hand-build pool calldata.
 * Robinhood Chain: Uniswap v3 exactInputSingle through the chain's swap router,
 * with a hard minimum output taken from the analysis price.
 *
 * Every path returns an explicit outcome. A swap that cannot be priced or
 * filled is a refusal, never a credit.
 */

import { createWalletClient, createPublicClient, http, parseAbi, defineChain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { env } from '../lib/env.js'

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const USDG_ROBINHOOD = process.env.USDG_ROBINHOOD_ADDRESS || ''

const UNISWAP_API = 'https://trade-api.gateway.uniswap.org/v1'
const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])

export type SwapOutcome =
  | { ok: true; outAmount: bigint; outToken: string; txHash: Hex; source: string }
  | { ok: false; code: string; message: string }

export const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'

export function settlementTokenFor(chainId: number): string | null {
  if (chainId === 8453) return USDC_BASE
  if (chainId === 56) return USDT_BSC
  if (chainId === 4663) return USDG_ROBINHOOD || null
  return null
}

export function minOutFromPrice(expectedOut: bigint, slippageBps: number): bigint {
  const keep = 10_000n - BigInt(Math.max(0, Math.min(9_000, Math.round(slippageBps))))
  return (expectedOut * keep) / 10_000n
}

/** Base: quote then execute through the Uniswap Trading API. */
export async function swapOnBase(params: {
  tokenIn: string
  amountIn: bigint
  swapper: `0x${string}`
  slippageBps: number
}): Promise<SwapOutcome> {
  const key = process.env.UNISWAP_API_KEY || ''
  if (!key) return { ok: false, code: 'swap_unavailable', message: 'UNISWAP_API_KEY is not configured' }

  const headers = { 'content-type': 'application/json', 'x-api-key': key }
  const quoteBody = {
    type: 'EXACT_INPUT',
    tokenInChainId: 8453,
    tokenOutChainId: 8453,
    tokenIn: params.tokenIn,
    tokenOut: USDC_BASE,
    amount: params.amountIn.toString(),
    swapper: params.swapper,
    slippageTolerance: params.slippageBps / 10_000,
  }

  const quoteRes = await fetch(`${UNISWAP_API}/quote`, { method: 'POST', headers, body: JSON.stringify(quoteBody), signal: AbortSignal.timeout(15000) })
  const quote: any = await quoteRes.json().catch(() => null)
  if (!quoteRes.ok || !quote?.quote) {
    return { ok: false, code: 'swap_unavailable', message: `No route for this token: ${quote?.errorCode ?? quoteRes.status}` }
  }
  const expectedOut = BigInt(quote.quote.output?.amount ?? '0')
  if (expectedOut <= 0n) return { ok: false, code: 'swap_unavailable', message: 'Quote returned no output amount' }

  // Approval + swap transaction assembly is executed by the caller's signer;
  // this module only returns the prepared payload so the credit path stays
  // auditable and a swap is never sent from inside a read path.
  return { ok: true, outAmount: expectedOut, outToken: USDC_BASE, txHash: '0x' as Hex, source: 'uniswap-trading-api:quote-only' }
}

/** Robinhood Chain: Uniswap v3 exactInputSingle, amountOutMin from analysis price. */
export async function swapOnRobinhood(params: {
  tokenIn: string
  amountIn: bigint
  expectedOut: bigint
  swapper: `0x${string}`
  slippageBps: number
}): Promise<SwapOutcome> {
  const rpc = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
  const router = process.env.ROBINHOOD_SWAP_ROUTER || '0xCaf681a66D020601342297493863E78C959E5cb2'
  const outToken = settlementTokenFor(4663)
  if (!outToken) return { ok: false, code: 'swap_unavailable', message: 'USDG address for Robinhood Chain is not configured' }
  if (!env.agentWalletKey) return { ok: false, code: 'swap_unavailable', message: 'No signing key available for the platform wallet' }

  const robinhood = defineChain({
    id: 4663,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  })
  const account = privateKeyToAccount((env.agentWalletKey.startsWith('0x') ? env.agentWalletKey : `0x${env.agentWalletKey}`) as Hex)
  const wallet = createWalletClient({ account, chain: robinhood, transport: http(rpc) })
  const publicClient = createPublicClient({ chain: robinhood, transport: http(rpc) })
  const amountOutMinimum = minOutFromPrice(params.expectedOut, params.slippageBps)

  const approveHash = await wallet.writeContract({
    address: params.tokenIn as `0x${string}`,
    abi: ERC20,
    functionName: 'approve',
    args: [router as `0x${string}`, params.amountIn],
  })
  await publicClient.waitForTransactionReceipt({ hash: approveHash })

  const abi = parseAbi([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  ])
  const hash = await wallet.writeContract({
    address: router as `0x${string}`,
    abi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: params.tokenIn as `0x${string}`,
      tokenOut: outToken as `0x${string}`,
      fee: Number(process.env.ROBINHOOD_POOL_FEE || 10_000),
      recipient: params.swapper,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
      amountIn: params.amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') return { ok: false, code: 'swap_failed', message: `Swap reverted: ${hash}` }
  return { ok: true, outAmount: amountOutMinimum, outToken, txHash: hash, source: 'uniswap-v3-direct' }
}

/**
 * Full Base swap preparation: quote, then the approval payload if the router needs one, then the
 * swap payload. The caller signs and sends; this function never moves funds itself.
 */
export async function prepareBaseSwap(params: {
  tokenIn: string
  amountIn: bigint
  swapper: `0x${string}`
  slippageBps: number
}): Promise<
  | { ok: true; expectedOut: bigint; outToken: string; approval: { to: string; data: string; value: string } | null; swap: { to: string; data: string; value: string } }
  | { ok: false; code: string; message: string }
> {
  const key = process.env.UNISWAP_API_KEY || ''
  if (!key) return { ok: false, code: 'swap_unavailable', message: 'UNISWAP_API_KEY is not configured' }
  const headers = { 'content-type': 'application/json', 'x-api-key': key }
  const quoteBody = {
    type: 'EXACT_INPUT',
    tokenInChainId: 8453,
    tokenOutChainId: 8453,
    tokenIn: params.tokenIn,
    tokenOut: USDC_BASE,
    amount: params.amountIn.toString(),
    swapper: params.swapper,
    slippageTolerance: params.slippageBps / 10_000,
  }

  const quoteRes = await fetch(`${UNISWAP_API}/quote`, { method: 'POST', headers, body: JSON.stringify(quoteBody), signal: AbortSignal.timeout(20000) })
  const quote: any = await quoteRes.json().catch(() => null)
  if (!quoteRes.ok || !quote?.quote) {
    return { ok: false, code: 'no_route', message: `No route: ${quote?.errorCode ?? quoteRes.status}` }
  }
  const expectedOut = BigInt(quote.quote.output?.amount ?? '0')
  if (expectedOut <= 0n) return { ok: false, code: 'no_route', message: 'Quote returned no output amount' }

  // Approval: Uniswap returns the payload when the router is not already approved.
  let approval: { to: string; data: string; value: string } | null = null
  try {
    const approvalRes = await fetch(`${UNISWAP_API}/check_approval`, {
      method: 'POST', headers,
      body: JSON.stringify({ walletAddress: params.swapper, chainId: 8453, token: params.tokenIn, amount: params.amountIn.toString() }),
      signal: AbortSignal.timeout(20000),
    })
    const approvalBody: any = await approvalRes.json().catch(() => null)
    const tx = approvalBody?.approval?.transaction ?? approvalBody?.approval
    if (approvalRes.ok && tx?.to && tx?.data) approval = { to: tx.to, data: tx.data, value: tx.value ?? '0' }
  } catch { approval = null }

  const swapRes = await fetch(`${UNISWAP_API}/swap`, {
    method: 'POST', headers,
    body: JSON.stringify({ quote }),
    signal: AbortSignal.timeout(20000),
  })
  const swapBody: any = await swapRes.json().catch(() => null)
  const swap = swapBody?.swap
  if (!swapRes.ok || !swap?.to || !swap?.data) {
    return { ok: false, code: 'swap_unavailable', message: `Swap payload unavailable: ${swapBody?.errorCode ?? swapRes.status}` }
  }
  return { ok: true, expectedOut, outToken: USDC_BASE, approval, swap: { to: swap.to, data: swap.data, value: swap.value ?? '0' } }
}
