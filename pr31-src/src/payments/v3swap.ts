import { createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import { USDC_BASE, minOutFromPrice } from './swap.js'

/**
 * Onchain Uniswap v3 quoting and swap assembly on Base.
 *
 * This exists because the trading-API path needs a vendor key we do not have, while the pool
 * state we need is readable from the chain for free. It quotes against QuoterV2 directly,
 * searches every fee tier plus the WETH hop, and returns calldata for SwapRouter02 — the router
 * the wallet policy already allows — so a conversion needs no third party to agree to it.
 */

export const BASE_V3 = {
  chainId: 8453,
  factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address,
  swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481' as Address,
  quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address,
  weth: '0x4200000000000000000000000000000000000006' as Address,
  usdc: USDC_BASE as Address,
}

/** Every tier Uniswap v3 deploys. A pool can exist and still be empty, so a failed quote is normal. */
export const FEE_TIERS = [100, 500, 3000, 10000] as const

export interface V3Reader {
  /** Returns null when the factory has no pool at that fee tier. */
  getPool(tokenA: Address, tokenB: Address, fee: number): Promise<Address | null>
  /** Rejects when the pool cannot serve the amount (empty, or no ticks initialized). */
  quoteExactInputSingle(params: { tokenIn: Address; tokenOut: Address; amountIn: bigint; fee: number }): Promise<bigint>
  /** Multi-hop, path encoded as tokenIn | fee | tokenMid | fee | tokenOut. */
  quoteExactInput(params: { path: Hex; amountIn: bigint }): Promise<bigint>
  /** ERC-20 allowance the owner has granted the spender. */
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>
}

export type V3Route = { hops: { tokenIn: Address; tokenOut: Address; fee: number }[]; amountOut: bigint }

export type PreparedBaseSwap =
  | {
      ok: true
      expectedOut: bigint
      outToken: string
      route: V3Route['hops']
      approval: { to: string; data: string; value: string } | null
      swap: { to: string; data: string; value: string }
    }
  | { ok: false; code: string; message: string }

/** tokenIn | fee (uint24, 3 bytes) | tokenOut, concatenated and hex encoded. */
export function encodeV3Path(hops: { tokenIn: Address; tokenOut: Address; fee: number }[]): Hex {
  if (hops.length === 0) throw new Error('a v3 path needs at least one hop')
  // Layout is tokenIn | fee | tokenOut | fee | tokenOut ..., so each hop appends its fee and its
  // output token and the middle token is written once, by the hop that produced it.
  let out = hops[0].tokenIn.slice(2).toLowerCase()
  for (const hop of hops) {
    out += hop.fee.toString(16).padStart(6, '0')
    out += hop.tokenOut.slice(2).toLowerCase()
  }
  return `0x${out}` as Hex
}

/** The zero address is the factory's way of saying no pool, so normalise it to null. */
export function poolOrNull(pool: string | null | undefined): Address | null {
  if (!pool) return null
  if (pool.toLowerCase() === '0x0000000000000000000000000000000000000000') return null
  return pool as Address
}

/** Best quote wins; a direct route beats an equal multi-hop because it costs less gas. */
export function pickBestRoute(routes: V3Route[]): V3Route | null {
  let best: V3Route | null = null
  for (const route of routes) {
    if (route.amountOut <= 0n) continue
    if (!best) { best = route; continue }
    if (route.amountOut > best.amountOut) best = route
    else if (route.amountOut === best.amountOut && route.hops.length < best.hops.length) best = route
  }
  return best
}

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
])
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

/**
 * Search direct tiers and the WETH hop, then assemble an approval (only when the router is not
 * already allowed) and the swap call itself. Refuses rather than returning an empty swap.
 */
export async function prepareBaseSwapOnchain(params: {
  tokenIn: Address
  amountIn: bigint
  swapper: Address
  slippageBps: number
  tokenOut?: Address
  reader: V3Reader
  router?: Address
}): Promise<PreparedBaseSwap> {
  const { tokenIn, amountIn, swapper, slippageBps, reader } = params
  const tokenOut = params.tokenOut ?? BASE_V3.usdc
  const router = params.router ?? BASE_V3.swapRouter02

  if (amountIn <= 0n) return { ok: false, code: 'zero_amount', message: 'Nothing to swap' }
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return { ok: false, code: 'already_settlement', message: 'Input is already the settlement token' }
  }

  const routes: V3Route[] = []
  const failures: string[] = []

  // Direct tier search.
  for (const fee of FEE_TIERS) {
    const pool = poolOrNull(await reader.getPool(tokenIn, tokenOut, fee).catch(() => null))
    if (!pool) continue
    try {
      const amountOut = await reader.quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee })
      routes.push({ hops: [{ tokenIn, tokenOut, fee }], amountOut })
    } catch (err) {
      failures.push(`direct ${fee}: ${(err as Error)?.message?.slice(0, 60) ?? 'quote failed'}`)
    }
  }

  // Two-hop through WETH, which is where most long-tail tokens actually have depth.
  for (const feeIn of FEE_TIERS) {
    const first = poolOrNull(await reader.getPool(tokenIn, BASE_V3.weth, feeIn).catch(() => null))
    if (!first) continue
    for (const feeOut of FEE_TIERS) {
      const second = poolOrNull(await reader.getPool(BASE_V3.weth, tokenOut, feeOut).catch(() => null))
      if (!second) continue
      const hops = [
        { tokenIn, tokenOut: BASE_V3.weth, fee: feeIn },
        { tokenIn: BASE_V3.weth, tokenOut, fee: feeOut },
      ]
      try {
        const amountOut = await reader.quoteExactInput({ path: encodeV3Path(hops), amountIn })
        routes.push({ hops, amountOut })
      } catch (err) {
        failures.push(`via ${feeIn}/${feeOut}: ${(err as Error)?.message?.slice(0, 60) ?? 'quote failed'}`)
      }
    }
  }

  const best = pickBestRoute(routes)
  if (!best) {
    return {
      ok: false,
      code: 'no_route',
      message: `No v3 pool can price this token for ${amountIn} base units${failures.length ? ` (${failures.slice(0, 3).join('; ')})` : ''}`,
    }
  }

  const amountOutMinimum = minOutFromPrice(best.amountOut, slippageBps)
  if (amountOutMinimum <= 0n) {
    return { ok: false, code: 'quote_too_small', message: `Quote of ${best.amountOut} leaves no floor above zero` }
  }

  const data =
    best.hops.length === 1
      ? encodeFunctionData({
          abi: routerAbi,
          functionName: 'exactInputSingle',
          args: [{
            tokenIn,
            tokenOut,
            fee: best.hops[0].fee,
            recipient: swapper,
            amountIn,
            amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          }],
        })
      : encodeFunctionData({
          abi: routerAbi,
          functionName: 'exactInput',
          args: [{ path: encodeV3Path(best.hops), recipient: swapper, amountIn, amountOutMinimum }],
        })

  // Approve only the amount being swapped, and only if the router cannot already pull it.
  let approval: { to: string; data: string; value: string } | null = null
  const existing = await reader.allowance(tokenIn, swapper, router).catch(() => 0n)
  if (existing < amountIn) {
    approval = {
      to: tokenIn,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, amountIn] }),
      value: '0',
    }
  }

  return {
    ok: true,
    expectedOut: best.amountOut,
    outToken: tokenOut,
    route: best.hops,
    approval,
    swap: { to: router, data, value: '0' },
  }
}

/** Thin live reader over the chain. Kept separate so tests can supply their own reader. */
export function liveV3Reader(rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org'): V3Reader {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) })
  const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
  const quoterAbi = parseAbi([
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
    'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  ])

  return {
    async getPool(tokenA, tokenB, fee) {
      const pool = await client.readContract({
        address: BASE_V3.factory,
        abi: factoryAbi,
        functionName: 'getPool',
        args: [tokenA, tokenB, fee],
      })
      return poolOrNull(pool)
    },
    async quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee }) {
      // QuoterV2 is not a view function; eth_call is how you read it without spending gas.
      const res = await client.simulateContract({
        address: BASE_V3.quoterV2,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      })
      return res.result[0]
    },
    async quoteExactInput({ path, amountIn }) {
      const res = await client.simulateContract({
        address: BASE_V3.quoterV2,
        abi: quoterAbi,
        functionName: 'quoteExactInput',
        args: [path, amountIn],
      })
      return res.result[0]
    },
    async allowance(token, owner, spender) {
      return client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
    },
  }
}
