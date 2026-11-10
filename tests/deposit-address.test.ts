// Deposit address selection: the platform may nominate a sponsored wallet as the address users
// send to, but a deposit is only creditable if verification accepts every wallet we control.
// These tests pin both halves, plus the guard that keeps the signer identity separate.
process.env.PGLITE_DIR = 'memory://'
process.env.PLATFORM_RECEIVER_ADDRESS = '0x1111111111111111111111111111111111111111'
process.env.PLATFORM_AGENT_RECEIVER = '0x3333333333333333333333333333333333333333'
process.env.PLATFORM_SPONSORED_RECEIVER = '0x4444444444444444444444444444444444444444'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { env, platformReceivers, depositAddress } = await import('../src/lib/env.js')
const { getChain } = await import('../src/payments/chains.js')
const { parseTransferLogs } = await import('../src/payments/verify.js')
const { getSigner } = await import('../src/payments/signer.js')

const SENDER = '0x2222222222222222222222222222222222222222'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function addressToTopic(addr: string): string {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

function uint256ToHex(val: bigint): string {
  return '0x' + val.toString(16).padStart(64, '0')
}

function receiptTo(to: string, value = 5_000_000n) {
  return {
    status: 'success',
    logs: [
      {
        address: USDC_BASE,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          addressToTopic(SENDER),
          addressToTopic(to),
        ],
        data: uint256ToHex(value),
      },
    ],
  }
}

describe('deposit address', () => {
  it('advertises the sponsored wallet when one is configured', () => {
    assert.equal(depositAddress(), '0x4444444444444444444444444444444444444444')
  })

  it('treats every configured wallet as ours, with no duplicates or blanks', () => {
    const list = platformReceivers()
    assert.deepEqual(list, [
      '0x1111111111111111111111111111111111111111',
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
    ])
    assert.equal(new Set(list).size, list.length)
  })

  it('never folds the sponsored wallet into the signer identity', () => {
    // platformAgentReceiver doubles as the Privy signer address. If the sponsored wallet leaked
    // into it, conversions would claim a deposit sits in a wallet this server cannot sign for.
    assert.notEqual(env.platformAgentReceiver, env.platformSponsorReceiver)
  })

  it('verifies a deposit to the sponsored wallet, not just to the vault', () => {
    const base = getChain('base')!
    const res = parseTransferLogs(
      receiptTo('0x4444444444444444444444444444444444444444'),
      base,
      platformReceivers(),
      SENDER
    )
    assert.equal(res.ok, true)
    if (res.ok) assert.equal(res.amount_usd_micros, 5_000_000)
  })

  it('still verifies the older wallets, so nothing already in flight is orphaned', () => {
    const base = getChain('base')!
    for (const to of [
      '0x1111111111111111111111111111111111111111',
      '0x3333333333333333333333333333333333333333',
    ]) {
      const res = parseTransferLogs(receiptTo(to), base, platformReceivers(), SENDER)
      assert.equal(res.ok, true, `expected ${to} to verify`)
    }
  })

  it('refuses a deposit sent to an address that is not ours', () => {
    const base = getChain('base')!
    const res = parseTransferLogs(
      receiptTo('0x5555555555555555555555555555555555555555'),
      base,
      platformReceivers(),
      SENDER
    )
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, 'wrong_recipient')
  })

  it('accepts a single address for callers that pass one, so the old shape keeps working', () => {
    const base = getChain('base')!
    const res = parseTransferLogs(
      receiptTo('0x1111111111111111111111111111111111111111'),
      base,
      '0x1111111111111111111111111111111111111111',
      SENDER
    )
    assert.equal(res.ok, true)
  })

  it('does not let the sponsored address stand in for a signer it has no key for', () => {
    // With only the sponsor receiver configured, no Privy triple and no local key, the platform
    // must report that it cannot sign rather than borrowing the sponsored address as its own.
    const signer = getSigner({
      PLATFORM_SPONSORED_RECEIVER: '0x4444444444444444444444444444444444444444',
    } as NodeJS.ProcessEnv)
    assert.equal(signer.ok, false)
    if (!signer.ok) assert.equal(signer.reason, 'no_signer')
  })
})
