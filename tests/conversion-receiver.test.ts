process.env.PGLITE_MODE = '1'
process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query } = await import('../src/db/index.js')
const { convertOne } = await import('../src/payments/convert.js')

const SIGNER_ADDRESS = '0x3333333333333333333333333333333333333333' as const
const PASSKEY_VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const signer = {
  kind: 'privy' as const,
  address: SIGNER_ADDRESS,
  async sendTransaction() { return ('0x' + 'ab'.repeat(32)) as `0x${string}` },
}

async function insertPayment(receivedByAddress: string | null): Promise<string> {
  const id = 'receiver_guard_' + randomUUID().replace(/-/g, '')
  await query(
    `INSERT INTO payments
      (id, chain_id, token, tx_hash, received_by, received_by_address, sender,
       raw_amount, decimals, usd_value_micros, status)
     VALUES ($1, 8453, $2, $3, 'treasury_vault', $4, $5, '1000000', 6, 1000000, 'pending_conversion')`,
    [id, TOKEN.toLowerCase(), '0x' + randomUUID().replace(/-/g, '').padEnd(64, '0'), receivedByAddress, PASSKEY_VAULT]
  )
  return id
}

describe('conversion receiver authorization', () => {
  before(async () => { await migrate() })

  it('fails closed when a legacy payment has no persisted receiving address', async () => {
    const id = await insertPayment(null)
    const result = await convertOne(id, { signer })
    assert.equal(result.status, 'blocked')
    if (result.status === 'blocked') assert.equal(result.reason, 'missing_receiver_address')
  })

  it('does not mistake the UI label for the wallet address or authorize a passkey-only vault', async () => {
    const id = await insertPayment(PASSKEY_VAULT)
    const result = await convertOne(id, { signer })
    assert.equal(result.status, 'blocked')
    if (result.status === 'blocked') {
      assert.equal(result.reason, 'not_in_signing_wallet')
      assert.match(result.detail, /cannot sign for/)
    }
  })
})
