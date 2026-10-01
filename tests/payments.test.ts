process.env.PGLITE_DIR = 'memory://'
process.env.PLATFORM_RECEIVER_ADDRESS = '0x1111111111111111111111111111111111111111'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'

const { migrate, query } = await import('../src/db/index.js')
const { env } = await import('../src/lib/env.js')
const { createSessionToken } = await import('../src/lib/session.js')
const { debitForUsage, creditDeposit, getBalanceMicros } = await import('../src/lib/billing.js')
const { CHAINS, getChain } = await import('../src/payments/chains.js')
const { parseTransferLogs } = await import('../src/payments/verify.js')
const { registerCreditsRoutes } = await import('../src/routes/credits.js')
const { registerStatsRoutes } = await import('../src/routes/stats.js')
import type { AppEnv } from '../src/lib/types.js'

function addressToTopic(addr: string): string {
  const clean = addr.toLowerCase().replace(/^0x/, '')
  return '0x' + clean.padStart(64, '0')
}

function uint256ToHex(val: bigint): string {
  return '0x' + val.toString(16).padStart(64, '0')
}

function makeFixtureReceipt({
  status = 'success',
  tokenAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  fromAddress = '0x2222222222222222222222222222222222222222',
  toAddress = '0x1111111111111111111111111111111111111111',
  value = 10000000n, // $10 USD (6 decimals)
}: {
  status?: string
  tokenAddress?: string
  fromAddress?: string
  toAddress?: string
  value?: bigint
} = {}) {
  return {
    status,
    logs: [
      {
        address: tokenAddress,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          addressToTopic(fromAddress),
          addressToTopic(toAddress),
        ],
        data: uint256ToHex(value),
      },
    ],
  }
}

describe('Payments & Credits Module B Tests', () => {
  const testUser = {
    id: 'usr_test_b',
    wallet: '0x2222222222222222222222222222222222222222',
    role: 'user',
  }

  before(async () => {
    await migrate()
    await query('INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      testUser.id,
      testUser.wallet,
      testUser.role,
    ])
  })

  it('(a) billing lifecycle from foundation', async () => {
    const userId = 'usr_billing_life'
    await query('INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      userId,
      '0x3333333333333333333333333333333333333333',
      'user',
    ])

    // Insufficient debit
    const debit1 = await debitForUsage(userId, 500, 'ref_fail')
    assert.equal(debit1.ok, false)
    assert.equal(debit1.balance, 0)

    // Deposit funds
    const dep = await creditDeposit(userId, 1000000, {
      chain: 'base',
      txHash: '0xlife1',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    })
    assert.equal(dep.credited, true)
    assert.equal(dep.balance, 1000000)

    // Sufficient debit
    const debit2 = await debitForUsage(userId, 400000, 'ref_pass')
    assert.equal(debit2.ok, true)
    assert.equal(debit2.balance, 600000)

    const finalBal = await getBalanceMicros(userId)
    assert.equal(finalBal, 600000)
  })

  it('(b) creditDeposit idempotency', async () => {
    const userId = 'usr_idempotent'
    await query('INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      userId,
      '0x4444444444444444444444444444444444444444',
      'user',
    ])

    const ref = {
      chain: 'base',
      txHash: '0xidem_tx_hash',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    }

    const first = await creditDeposit(userId, 5000000, ref)
    assert.equal(first.credited, true)
    assert.equal(first.balance, 5000000)

    const second = await creditDeposit(userId, 5000000, ref)
    assert.equal(second.credited, false)
    assert.equal(second.balance, 5000000)

    const depRows = await query('SELECT * FROM deposits WHERE chain = $1 AND tx_hash = $2', [
      ref.chain,
      ref.txHash,
    ])
    assert.equal(depRows.rowCount, 1)
  })

  it('(c) parseTransferLogs fixture tests', async () => {
    const baseChain = getChain('base')!
    const receiver = '0x1111111111111111111111111111111111111111'
    const sender = '0x2222222222222222222222222222222222222222'

    // 1. Correct transfer
    const res1 = parseTransferLogs(makeFixtureReceipt(), baseChain, receiver, sender)
    assert.equal(res1.ok, true)
    if (res1.ok) {
      assert.equal(res1.token, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
      assert.equal(res1.amount_usd_micros, 10000000)
    }

    // 2. Wrong sender
    const res2 = parseTransferLogs(
      makeFixtureReceipt({ fromAddress: '0x9999999999999999999999999999999999999999' }),
      baseChain,
      receiver,
      sender
    )
    assert.equal(res2.ok, false)
    if (!res2.ok) assert.equal(res2.code, 'wrong_sender')

    // 3. Wrong recipient
    const res3 = parseTransferLogs(
      makeFixtureReceipt({ toAddress: '0x9999999999999999999999999999999999999999' }),
      baseChain,
      receiver,
      sender
    )
    assert.equal(res3.ok, false)
    if (!res3.ok) assert.equal(res3.code, 'wrong_recipient')

    // 4. Unsupported token
    const res4 = parseTransferLogs(
      makeFixtureReceipt({ tokenAddress: '0x9999999999999999999999999999999999999999' }),
      baseChain,
      receiver,
      sender
    )
    assert.equal(res4.ok, false)
    if (!res4.ok) assert.equal(res4.code, 'unsupported_token')

    // 5. Failed tx
    const res5 = parseTransferLogs(
      makeFixtureReceipt({ status: 'reverted' }),
      baseChain,
      receiver,
      sender
    )
    assert.equal(res5.ok, false)
    if (!res5.ok) assert.equal(res5.code, 'failed_tx')

    // 6. Zero amount
    const res6 = parseTransferLogs(makeFixtureReceipt({ value: 0n }), baseChain, receiver, sender)
    assert.equal(res6.ok, false)
    if (!res6.ok) assert.equal(res6.code, 'zero_amount')
  })

  it('(d) route integration tests', async () => {
    const app = new Hono<AppEnv>()
    registerCreditsRoutes(app)
    registerStatsRoutes(app)

    const sessionToken = await createSessionToken(testUser)

    // GET /api/credits
    const credRes = await app.request('/api/credits', {
      headers: { 'x-session-token': sessionToken },
    })
    assert.equal(credRes.status, 200)
    const credJson = await credRes.json()
    assert.equal(typeof credJson.balance_usd_micros, 'number')
    assert.ok(Array.isArray(credJson.ledger))

    // GET /api/credits/deposit-info
    const infoRes = await app.request('/api/credits/deposit-info', {
      headers: { 'x-session-token': sessionToken },
    })
    assert.equal(infoRes.status, 200)
    const infoJson = await infoRes.json()
    assert.equal(infoJson.configured, true)
    assert.equal(infoJson.receiver_address, '0x1111111111111111111111111111111111111111')
    assert.ok(Array.isArray(infoJson.chains))

    // POST /api/credits/deposit with bad chain
    const badChainRes = await app.request('/api/credits/deposit', {
      method: 'POST',
      headers: {
        'x-session-token': sessionToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chain: 'non_existent_chain', tx_hash: '0x123' }),
    })
    assert.equal(badChainRes.status, 404)
    const badChainJson = await badChainRes.json()
    assert.equal(badChainJson.error.code, 'not_found')

    // POST /api/credits/deposit with configured receiver and fake zero txHash
    const fakeZeroTxHash = '0x' + '0'.repeat(64)
    const fakeZeroRes = await app.request('/api/credits/deposit', {
      method: 'POST',
      headers: {
        'x-session-token': sessionToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chain: 'base', tx_hash: fakeZeroTxHash }),
    })
    assert.equal(fakeZeroRes.status, 404)
    const fakeZeroJson = await fakeZeroRes.json()
    assert.equal(fakeZeroJson.error.code, 'not_found')

    // Unconfigured receiver address behavior
    const origReceiver = env.platformReceiverAddress
    env.platformReceiverAddress = ''

    const unconfInfoRes = await app.request('/api/credits/deposit-info', {
      headers: { 'x-session-token': sessionToken },
    })
    const unconfInfoJson = await unconfInfoRes.json()
    assert.equal(unconfInfoJson.configured, false)

    const unconfDepRes = await app.request('/api/credits/deposit', {
      method: 'POST',
      headers: {
        'x-session-token': sessionToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chain: 'base', tx_hash: fakeZeroTxHash }),
    })
    assert.equal(unconfDepRes.status, 503)
    const unconfDepJson = await unconfDepRes.json()
    assert.equal(unconfDepJson.error.message, 'Platform receiver wallet not configured')

    env.platformReceiverAddress = origReceiver

    // GET /api/stats/me
    const statsMeRes = await app.request('/api/stats/me', {
      headers: { 'x-session-token': sessionToken },
    })
    assert.equal(statsMeRes.status, 200)
    const statsMeJson = await statsMeRes.json()
    assert.equal(statsMeJson.length, 14)

    // GET /api/stats/public
    const statsPubRes = await app.request('/api/stats/public')
    assert.equal(statsPubRes.status, 200)
    const statsPubJson = await statsPubRes.json()
    assert.ok(statsPubJson.totals)
    assert.equal(statsPubJson.series.length, 30)
  })
})
