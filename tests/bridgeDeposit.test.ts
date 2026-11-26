import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  quoteBridgeDeposit,
  parseQuote,
  parseStatus,
  buildQuoteQuery,
  isSupportedSource,
  BRIDGE_DEST_CHAIN,
  BRIDGE_DEST_TOKEN,
  BRIDGE_MIN_USD,
} from '../src/payments/bridgeDeposit.js'

const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const WALLET = '0x73f1619115ff9280ebf9084f29509f795b57487b'

/** Shape captured from a real GET /v1/quote on 2026-11-18 (Arbitrum to Base, across). */
const realQuote = {
  type: 'lifi',
  action: { fromChainId: 42161, toChainId: 8453, fromAmount: '10000000', toToken: { address: BRIDGE_DEST_TOKEN } },
  estimate: {
    tool: 'across',
    toAmount: '9970908',
    toAmountMin: '9970908',
    toAmountUSD: '9.9529',
    executionDuration: 2,
    approvalAddress: '0x1231DEB6f5740000000000000000000000000000',
    feeCosts: [
      { name: 'LIFI Fixed Fee', amountUSD: '0.0250', percentage: '0.0025' },
      { name: 'Relayer fee', amountUSD: '0.0010' },
    ],
  },
  transactionRequest: { to: '0x1231DEB6f5740000000000000000000000000000', data: '0xdeadbeef', value: '0x0', gasLimit: '0x2ae8dd' },
}

function deps(body: unknown, status = 200) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(String(url))
    return { status, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const args = { fromChain: 42161, fromToken: USDC_ARB, fromAmountRaw: '10000000', fromAddress: WALLET }

test('the flow is off unless it is enabled', async () => {
  const r = await quoteBridgeDeposit(args, { enabled: false, apiKey: 'k', fetchImpl: deps(realQuote).fetchImpl })
  assert.deepEqual(r, { ok: false, reason: 'disabled' })
})

test('a missing API key refuses rather than sending an anonymous call', async () => {
  const { fetchImpl, calls } = deps(realQuote)
  const r = await quoteBridgeDeposit(args, { enabled: true, apiKey: '', fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.reason, 'no_api_key')
  assert.equal(calls.length, 0)
})

test('an unsupported source chain is refused before any request', async () => {
  const { fetchImpl, calls } = deps(realQuote)
  const r = await quoteBridgeDeposit({ ...args, fromChain: 56 }, { enabled: true, apiKey: 'k', fetchImpl })
  assert.equal(!r.ok && r.reason, 'unsupported_source_chain')
  assert.equal(calls.length, 0)
  assert.equal(isSupportedSource(42161), true)
  assert.equal(isSupportedSource(56), false)
})

test('an amount of zero or junk is refused', async () => {
  for (const bad of ['0', '', '1.5', '-1']) {
    const r = await quoteBridgeDeposit({ ...args, fromAmountRaw: bad }, { enabled: true, apiKey: 'k', fetchImpl: deps(realQuote).fetchImpl })
    assert.equal(!r.ok && r.reason, 'amount_required', `amount ${bad}`)
  }
})

test('the request carries the six required parameters and pins the destination', async () => {
  const { fetchImpl, calls } = deps(realQuote)
  await quoteBridgeDeposit({ ...args, slippage: 0.005 }, { enabled: true, apiKey: 'k', fetchImpl })
  const u = new URL(calls[0])
  assert.equal(u.pathname, '/v1/quote')
  assert.equal(u.searchParams.get('fromChain'), '42161')
  assert.equal(u.searchParams.get('toChain'), '8453')
  assert.equal(u.searchParams.get('fromToken'), USDC_ARB)
  assert.equal(u.searchParams.get('toToken'), BRIDGE_DEST_TOKEN)
  assert.equal(u.searchParams.get('fromAddress'), WALLET)
  assert.equal(u.searchParams.get('fromAmount'), '10000000')
  assert.equal(u.searchParams.get('slippage'), '0.005')
})

test('the destination is not caller-controlled', () => {
  const q = buildQuoteQuery(args)
  assert.equal(q.toChain, String(BRIDGE_DEST_CHAIN))
  assert.equal(q.toChain, '8453')
})

test('a small route is refused on its measured value, because the fixed fee eats it', async () => {
  const { fetchImpl } = deps(realQuote)
  const r = await quoteBridgeDeposit(args, { enabled: true, apiKey: 'k', fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.reason, 'below_minimum')
  assert.ok(!r.ok && String(r.detail).includes(String(BRIDGE_MIN_USD)))
})

test('a route above the floor comes back with a signable transaction', async () => {
  const big = {
    ...realQuote,
    estimate: { ...realQuote.estimate, toAmountUSD: '250.50', toAmount: '250000000' },
  }
  const { fetchImpl } = deps(big)
  const r = await quoteBridgeDeposit(args, { enabled: true, apiKey: 'k', fetchImpl })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.quote.tool, 'across')
  assert.equal(r.quote.toAmountUsd, 250.5)
  assert.equal(r.quote.fromChainId, 42161)
  assert.equal(r.quote.toChainId, 8453)
  assert.equal(r.quote.executionDurationSeconds, 2)
  assert.deepEqual(r.quote.feeCosts.map((f) => f.name), ['LIFI Fixed Fee', 'Relayer fee'])
  assert.equal(r.quote.transactionRequest.to, '0x1231DEB6f5740000000000000000000000000000')
  assert.equal(r.quote.transactionRequest.data, '0xdeadbeef')
})

test('an error body is a refusal, never an exception', () => {
  const r = parseQuote({ message: 'No available quotes for the requested transfer' })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.reason, 'no_route')
  assert.ok(!r.ok && String(r.detail).includes('No available quotes'))
})

test('a quote without a signable transaction is refused', () => {
  const r = parseQuote({ ...realQuote, transactionRequest: undefined })
  assert.equal(!r.ok && r.reason, 'no_transaction')
})

test('a rate-limited bridge is its own reason so the caller can back off', async () => {
  const { fetchImpl } = deps({}, 429)
  const r = await quoteBridgeDeposit(args, { enabled: true, apiKey: 'k', fetchImpl })
  assert.equal(!r.ok && r.reason, 'rate_limited')
})

test('status maps to a hint, and only DONE is done', () => {
  assert.deepEqual(parseStatus({ status: 'DONE', substatus: 'COMPLETED' }), { state: 'done', substatus: 'COMPLETED' })
  assert.equal(parseStatus({ status: 'PENDING', substatus: 'BRIDGE_NOT_AVAILABLE' }).state, 'pending')
  assert.equal(parseStatus({ status: 'FAILED', substatus: 'REFUNDED' }).state, 'failed')
  assert.equal(parseStatus({}).state, 'not_found')
  assert.equal(parseStatus({ status: 'SOMETHING_NEW' }).state, 'not_found')
})
