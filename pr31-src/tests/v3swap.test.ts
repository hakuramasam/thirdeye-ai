import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import {
  BASE_V3,
  encodeV3Path,
  pickBestRoute,
  poolOrNull,
  prepareBaseSwapOnchain,
  type V3Reader,
  type V3Route,
} from '../src/payments/v3swap.js'

const TOKEN = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' as Address
const WETH = BASE_V3.weth
const USDC = BASE_V3.usdc
const SWAPPER = '0xb09f37a1110a126d63463Ec08a0C0B97612D90ab' as Address
const DUMMY_POOL = '0x8f8799cef65e4dda2853619ada8f5290493f3ae5' as Address

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
])
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

/**
 * Reader stub: pools and quotes are given per fee tier so each test states the market it is
 * asserting against instead of depending on live chain state.
 */
function reader(opts: {
  directPools?: number[]
  directQuotes?: Record<number, bigint>
  wethPools?: number[]
  wethOutPools?: number[]
  twoHopQuotes?: Record<string, bigint>
  failing?: number[]
  allowance?: bigint
}): V3Reader {
  const direct = opts.directPools ?? []
  const weth = opts.wethPools ?? []
  const wethOut = opts.wethOutPools ?? []
  return {
    async getPool(tokenA, tokenB, fee) {
      if (tokenA.toLowerCase() === WETH.toLowerCase() && tokenB.toLowerCase() === USDC.toLowerCase()) {
        return wethOut.includes(fee) ? DUMMY_POOL : null
      }
      if (tokenB.toLowerCase() === USDC.toLowerCase()) return direct.includes(fee) ? DUMMY_POOL : null
      if (tokenB.toLowerCase() === WETH.toLowerCase()) return weth.includes(fee) ? DUMMY_POOL : null
      return null
    },
    async quoteExactInputSingle({ fee }) {
      if (opts.failing?.includes(fee)) throw new Error('execution reverted: no liquidity')
      return opts.directQuotes?.[fee] ?? 0n
    },
    async quoteExactInput({ path }) {
      const key = path.slice(-46, -40) // trailing fee sits just before the final token
      return opts.twoHopQuotes?.[key] ?? 0n
    },
    async allowance() {
      return opts.allowance ?? 0n
    },
  }
}

test('a v3 path is tokenIn, then fee and tokenOut per hop', () => {
  assert.equal(
    encodeV3Path([{ tokenIn: TOKEN, tokenOut: USDC, fee: 3000 }]),
    `0x${TOKEN.slice(2).toLowerCase()}000bb8${USDC.slice(2).toLowerCase()}`
  )
  const twoHop = encodeV3Path([
    { tokenIn: TOKEN, tokenOut: WETH, fee: 10000 },
    { tokenIn: WETH, tokenOut: USDC, fee: 500 },
  ])
  // 20 bytes + 3 + 20 + 3 + 20
  assert.equal(twoHop.length, 2 + (20 + 3 + 20 + 3 + 20) * 2)
  assert.ok(twoHop.includes('002710'), 'first fee is 10000 in hex')
  assert.ok(twoHop.endsWith('01f4' + USDC.slice(2).toLowerCase()), 'last hop is fee 500 then USDC')
})

test('the factory zero address means no pool', () => {
  assert.equal(poolOrNull('0x0000000000000000000000000000000000000000'), null)
  assert.equal(poolOrNull(DUMMY_POOL), DUMMY_POOL)
  assert.equal(poolOrNull(null), null)
})

test('the best quote wins, and a tie goes to the cheaper direct route', () => {
  const direct: V3Route = { hops: [{ tokenIn: TOKEN, tokenOut: USDC, fee: 3000 }], amountOut: 100n }
  const via: V3Route = {
    hops: [
      { tokenIn: TOKEN, tokenOut: WETH, fee: 10000 },
      { tokenIn: WETH, tokenOut: USDC, fee: 500 },
    ],
    amountOut: 120n,
  }
  assert.equal(pickBestRoute([direct, via])?.amountOut, 120n, 'higher output beats fewer hops')
  const sameDirect: V3Route = { hops: [{ tokenIn: TOKEN, tokenOut: USDC, fee: 500 }], amountOut: 120n }
  assert.equal(pickBestRoute([via, sameDirect])?.hops.length, 1, 'equal output prefers one hop')
  assert.equal(pickBestRoute([{ ...direct, amountOut: 0n }]), null, 'zero output is not a route')
})

test('a direct route becomes exactInputSingle with a slippage floor and a scoped approval', async () => {
  const prepared = await prepareBaseSwapOnchain({
    tokenIn: TOKEN,
    amountIn: 1000n * 10n ** 18n,
    swapper: SWAPPER,
    slippageBps: 150,
    reader: reader({ directPools: [500, 3000], directQuotes: { 500: 100_000n, 3000: 800_000n } }),
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.expectedOut, 800_000n, 'picks the deeper tier, not the first pool found')
  assert.equal(prepared.route.length, 1)
  assert.equal(prepared.swap.to, BASE_V3.swapRouter02, 'the router the policy allows, not a vendor endpoint')

  const decoded = decodeFunctionData({ abi: routerAbi, data: prepared.swap.data as Hex })
  assert.equal(decoded.functionName, 'exactInputSingle')
  const args = (decoded.args as any)[0]
  assert.equal(args.tokenIn.toLowerCase(), TOKEN.toLowerCase())
  assert.equal(args.tokenOut.toLowerCase(), USDC.toLowerCase())
  assert.equal(args.fee, 3000)
  assert.equal(args.recipient.toLowerCase(), SWAPPER.toLowerCase())
  assert.equal(args.amountIn, 1000n * 10n ** 18n)
  // 1.5% slippage floor, floor division: 800000 - 12000
  assert.equal(args.amountOutMinimum, 788_000n)

  assert.ok(prepared.approval, 'no allowance means an approval is required')
  const approve = decodeFunctionData({ abi: erc20Abi, data: prepared.approval!.data as Hex })
  assert.equal(approve.functionName, 'approve')
  assert.equal((approve.args as any)[0].toLowerCase(), BASE_V3.swapRouter02.toLowerCase())
  assert.equal((approve.args as any)[1], 1000n * 10n ** 18n, 'approves the swapped amount, not an unlimited allowance')
  assert.equal(prepared.approval!.to.toLowerCase(), TOKEN.toLowerCase(), 'approval goes to the token contract')
})

test('an existing allowance removes the approval transaction', async () => {
  const prepared = await prepareBaseSwapOnchain({
    tokenIn: TOKEN,
    amountIn: 1000n,
    swapper: SWAPPER,
    slippageBps: 150,
    reader: reader({ directPools: [3000], directQuotes: { 3000: 5000n }, allowance: 1000n }),
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.approval, null)
})

test('with no direct pool the swap routes through WETH and encodes the path', async () => {
  const prepared = await prepareBaseSwapOnchain({
    tokenIn: TOKEN,
    amountIn: 10n ** 18n,
    swapper: SWAPPER,
    slippageBps: 100,
    reader: reader({ wethPools: [10000], wethOutPools: [500], twoHopQuotes: { '0001f4': 900_000n } }),
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.route.length, 2)
  const decoded = decodeFunctionData({ abi: routerAbi, data: prepared.swap.data as Hex })
  assert.equal(decoded.functionName, 'exactInput')
  const hop = (decoded.args as any)[0]
  assert.equal(hop.path, encodeV3Path([
    { tokenIn: TOKEN, tokenOut: WETH, fee: 10000 },
    { tokenIn: WETH, tokenOut: USDC, fee: 500 },
  ]))
  assert.equal(hop.recipient.toLowerCase(), SWAPPER.toLowerCase())
  assert.equal(hop.amountIn, 10n ** 18n)
  assert.equal(hop.amountOutMinimum, 891_000n, '1% floor')
})

test('a pool that exists but cannot price the amount is skipped, not fatal', async () => {
  const prepared = await prepareBaseSwapOnchain({
    tokenIn: TOKEN,
    amountIn: 10n ** 18n,
    swapper: SWAPPER,
    slippageBps: 150,
    reader: reader({ directPools: [100, 3000], directQuotes: { 100: 1n, 3000: 5000n }, failing: [100] }),
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.expectedOut, 5000n)
  assert.equal(prepared.route[0].fee, 3000)
})

test('no pool anywhere refuses with no_route and says why', async () => {
  const prepared = await prepareBaseSwapOnchain({
    tokenIn: TOKEN,
    amountIn: 10n ** 18n,
    swapper: SWAPPER,
    slippageBps: 150,
    reader: reader({ directPools: [100], failing: [100] }),
  })
  assert.equal(prepared.ok, false)
  if (prepared.ok) return
  assert.equal(prepared.code, 'no_route')
  assert.match(prepared.message, /No v3 pool/)
})

test('a floor that rounds down to zero is refused rather than swapped unprotected', async () => {
  const prepared = await prepareBaseSwapOnchain({
    tokenIn: TOKEN,
    amountIn: 10n ** 18n,
    swapper: SWAPPER,
    slippageBps: 9_000,
    reader: reader({ directPools: [3000], directQuotes: { 3000: 5n } }),
  })
  assert.equal(prepared.ok, false)
  if (prepared.ok) return
  assert.equal(prepared.code, 'quote_too_small')
})

test('swapping a token into itself is refused before any quote', async () => {
  const prepared = await prepareBaseSwapOnchain({
    tokenIn: USDC,
    amountIn: 10n ** 6n,
    swapper: SWAPPER,
    slippageBps: 150,
    reader: reader({ directPools: [100], directQuotes: { 100: 10n ** 6n } }),
  })
  assert.equal(prepared.ok, false)
  if (prepared.ok) return
  assert.equal(prepared.code, 'already_settlement')
})
