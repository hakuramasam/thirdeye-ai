import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS } from '../src/payments/chains.js'

// A testnet inside the production payment path would be a free-money bug: a
// stablecoin is valued 1:1 with no oracle, so testnet USDC would credit real
// balance for nothing. Sepolia is rehearsed by scripts/rehearse-sepolia.mjs,
// which talks to Sepolia directly and never touches production state.
test('no testnet chain is registered in the production payment path', () => {
  const ids = CHAINS.map((c) => c.chainId)
  for (const testnet of [84532, 11155111, 84531, 97]) {
    assert.equal(ids.includes(testnet), false, `testnet ${testnet} must not be in CHAINS`)
  }
})

test('every production chain has a settlement stablecoin', () => {
  for (const c of CHAINS) {
    assert.ok(c.settlement?.address, `${c.id} is missing a settlement stablecoin`)
  }
})
