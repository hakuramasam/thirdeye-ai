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

import { planSweep, sweepAmount } from '../src/lib/sweepGuard.js'

const TOKEN = '0xbf981cfF5040F9652D4721c85C3e05F6d79f9b07'
const DEPLOYER = '0x3F3C5af93542B42E5f457CB3711Bc551f2898dEF'
const TREASURY = '0x73fAf95B2Baa23bde4CE8547b64C55159022Cf0d'

test('a funded sweep to a different wallet passes', () => {
  const p = planSweep({ tokenAddress: TOKEN, deployer: DEPLOYER, treasury: TREASURY, balanceWei: 250n * 10n ** 24n, gasBalanceEth: 0.01 })
  assert.equal(p.ok, true)
  assert.deepEqual(p.reasons, [])
})

test('the sweep refuses to send to itself', () => {
  const p = planSweep({ tokenAddress: TOKEN, deployer: DEPLOYER, treasury: DEPLOYER, balanceWei: 1n, gasBalanceEth: 0.01 })
  assert.equal(p.ok, false)
  assert.match(p.reasons.join(' '), /same wallet/)
})

test('the sweep refuses with no tokens or no gas', () => {
  assert.equal(planSweep({ tokenAddress: TOKEN, deployer: DEPLOYER, treasury: TREASURY, balanceWei: 0n, gasBalanceEth: 0.01 }).ok, false)
  const noGas = planSweep({ tokenAddress: TOKEN, deployer: DEPLOYER, treasury: TREASURY, balanceWei: 10n, gasBalanceEth: 0.00001 })
  assert.equal(noGas.ok, false)
  assert.match(noGas.reasons.join(' '), /gas balance/)
})

test('a malformed token address stops the sweep', () => {
  assert.equal(planSweep({ tokenAddress: '0xnotatoken', deployer: DEPLOYER, treasury: TREASURY, balanceWei: 10n, gasBalanceEth: 0.01 }).ok, false)
})

test('the amount respects the reserve floor', () => {
  assert.equal(sweepAmount(1_000n, 250n), 750n)
  assert.equal(sweepAmount(100n, 250n), 0n)
  assert.equal(sweepAmount(1_000n), 1_000n)
})
