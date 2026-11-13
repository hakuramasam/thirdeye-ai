import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS, getChain } from '../src/payments/chains.js'

const base = () => {
  const chain = getChain('base')
  assert.ok(chain, 'base chain must be configured')
  return chain
}

test('the tracked base tokens are exactly the ones Sam approved', () => {
  assert.deepEqual(
    base().tokens.map((t) => t.symbol),
    ['USDC', 'TREND', 'haku85', 'AASA'],
    'adding any other token would mean tracking assets nobody asked for'
  )
})

test('$HAKU85 and $haku85 are one contract, not two entries', () => {
  const addresses = base().tokens.map((t) => t.address.toLowerCase())
  assert.equal(new Set(addresses).size, addresses.length, 'no token may appear twice')
  const haku = base().tokens.filter((t) => /haku85/i.test(t.symbol))
  assert.equal(haku.length, 1, 'the creator coin answers to both spellings')
  assert.equal(haku[0].address, '0xf21ec85ce0b05640436ffd7e8fabba5d82eb0774')
})

test('every tracked token carries the verified contract facts', () => {
  const expected: Record<string, string> = {
    TREND: '0xbf981cfF5040F9652D4721c85C3e05F6d79f9b07',
    haku85: '0xf21ec85ce0b05640436ffd7e8fabba5d82eb0774',
    AASA: '0xb2000000000000000000001582178dd38a037f83',
  }
  for (const [symbol, address] of Object.entries(expected)) {
    const token = base().tokens.find((t) => t.symbol === symbol)
    assert.ok(token, `${symbol} must be tracked`)
    assert.equal(token.address, address)
    assert.equal(token.decimals, 18, 'all three read 18 decimals onchain')
    assert.equal(token.stable, false, 'none of these is a stablecoin')
  }
})

test('illiquid tokens are gated by an oracle floor, never valued at face value', () => {
  for (const token of base().tokens.filter((t) => !t.stable)) {
    assert.ok(token.oracle, `${token.symbol} must be priced, not credited 1:1`)
    // The platform token is priced by ops policy, not by a market we run, so the
    // market-floor assertions below deliberately do not apply to it.
    if (token.oracle.provider === 'policy') continue
    assert.equal(token.oracle.provider, 'geckoterminal')
    assert.ok((token.oracle.minLiquidityUsd ?? 0) > 0, 'a liquidity floor keeps dust pools out')
    assert.ok(token.oracle.maxDepositUsd <= 25, `${token.symbol} stays small until it trades`)
    assert.ok(token.oracle.haircutBps > 0, 'credit must sit below the quoted price')
  }
})
