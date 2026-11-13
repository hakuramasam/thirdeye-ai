process.env.PGLITE_DIR = 'memory://'

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { parseTransferLogs } = await import('../src/payments/verify.js')
const { getTokenPriceUsd } = await import('../src/payments/oracle.js')
const { getChain } = await import('../src/payments/chains.js')

const RECEIVER = '0x73faf95b2baa23bde4ce8547b64c55159022cf0d'
const SENDER = '0x4e26fc6eb05a1cdbd762609fde9958e5b8cc754d'
const TREND = '0xbf981cfF5040F9652D4721c85C3e05F6d79f9b07'

function receiptForToken(token: string, value: bigint, to = RECEIVER, from = SENDER) {
  const topic = (addr: string) => '0x' + '0'.repeat(24) + addr.toLowerCase().slice(2)
  return {
    status: 'success',
    logs: [
      {
        address: token,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          topic(from),
          topic(to),
        ],
        data: '0x' + value.toString(16).padStart(64, '0'),
      },
    ],
  }
}

const realFetch = globalThis.fetch
after(() => {
  globalThis.fetch = realFetch
})

describe('Oracle-priced deposit tokens', () => {
  const base = getChain('base')!

  it('TREND is configured as an oracle-priced token on Base', () => {
    const token = base.tokens.find((t) => t.symbol === 'TREND')!
    assert.ok(token, 'TREND missing from Base tokens')
    assert.equal(token.decimals, 18)
    assert.equal(token.stable, false)
    assert.equal(token.oracle?.minLiquidityUsd, 5000)
    assert.equal(token.oracle?.maxDepositUsd, 25)
    assert.equal(token.oracle?.haircutBps, 1000)
  })

  it('parses a TREND transfer but defers valuation', () => {
    const res = parseTransferLogs(receiptForToken(TREND, 2_280_000n * 10n ** 18n), base, RECEIVER, SENDER)
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.amount_usd_micros, 0)
    assert.equal(res.raw_amount, (2_280_000n * 10n ** 18n).toString())
  })

  it('still values stablecoins 1:1 without an oracle call', () => {
    const usdc = base.tokens.find((t) => t.symbol === 'USDC')!
    const res = parseTransferLogs(receiptForToken(usdc.address, 500_000n), base, RECEIVER, SENDER)
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.amount_usd_micros, 500_000) // $0.50
  })

  it('reports price and liquidity from the quote', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = String(url)
      if (u.includes('/pools')) {
        return new Response(JSON.stringify({ data: [{ attributes: { reserve_in_usd: '15935.02' } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { attributes: { price_usd: '0.00000021935' } } }), { status: 200 })
    }) as any
    const token = base.tokens.find((t) => t.symbol === 'TREND')!
    const quote = await getTokenPriceUsd(token)
    assert.ok(quote)
    assert.equal(quote!.priceUsd, 0.00000021935)
    assert.equal(Math.round(quote!.liquidityUsd), 15935)
  })

  it('refuses to quote when the oracle is unreachable', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as any
    const token = base.tokens.find((t) => t.symbol === 'TREND')!
    assert.equal(await getTokenPriceUsd(token), null)
  })
})
