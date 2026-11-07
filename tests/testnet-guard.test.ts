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

import { hashPartnerKey, newPartnerKey, bearerToken, hasScope } from '../src/routes/partner.js'

test('partner keys are stored hashed and hashing is deterministic', () => {
  const { token, hash, prefix } = newPartnerKey()
  assert.equal(hashPartnerKey(token), hash)
  assert.equal(prefix, token.slice(0, 11))
  assert.notEqual(hash, token)
})

test('two issued keys never collide', () => {
  const a = newPartnerKey(), b = newPartnerKey()
  assert.notEqual(a.token, b.token)
  assert.notEqual(a.hash, b.hash)
})

test('bearer parsing rejects malformed headers', () => {
  assert.equal(bearerToken('Bearer pk-abc'), 'pk-abc')
  assert.equal(bearerToken('bearer  pk-abc '), 'pk-abc')
  assert.equal(bearerToken('Token pk-abc'), null)
  assert.equal(bearerToken(undefined), null)
  assert.equal(bearerToken('Bearer '), null)
})

test('scopes gate reads and writes, and admin implies both', () => {
  assert.equal(hasScope(['read'], 'read'), true)
  assert.equal(hasScope(['read'], 'write'), false)
  assert.equal(hasScope([], 'read'), false)
  assert.equal(hasScope(undefined, 'read'), false)
  assert.equal(hasScope(['admin'], 'write'), true)
  assert.equal(hasScope(['admin'], 'read'), true)
})

import { threadFor, isOverWriteLimit, PARTNER_WRITE_LIMIT } from '../src/routes/partner.js'

test('each partner org maps to its own stable thread', () => {
  assert.equal(threadFor('Vesper Intelligence'), 'vesper-intelligence')
  assert.equal(threadFor('Vesper  Intelligence!!'), 'vesper-intelligence')
  assert.equal(threadFor('ACME Corp'), 'acme-corp')
  assert.equal(threadFor(''), 'general')
  assert.equal(threadFor('---'), 'general')
})

test('two different partners never share a thread', () => {
  assert.notEqual(threadFor('Vesper Intelligence'), threadFor('Acme Corp'))
})

test('the write throttle opens then closes', () => {
  assert.equal(isOverWriteLimit(0), false)
  assert.equal(isOverWriteLimit(PARTNER_WRITE_LIMIT - 1), false)
  assert.equal(isOverWriteLimit(PARTNER_WRITE_LIMIT), true)
  assert.equal(isOverWriteLimit(PARTNER_WRITE_LIMIT + 5), true)
})

import { pricePer1m, capabilityCard, agentCard, a2aResponse } from '../src/routes/discovery.js'
import { classifyVerification, txHashFrom } from '../src/lib/partnerVerify.js'

test('public catalogue shows catalogue and billed prices, margin included', () => {
  const p = pricePer1m(150_000) // $0.15 per 1M catalogue
  assert.equal(p.catalog_usd, 0.15)
  assert.equal(p.billed_usd, 0.165) // +10%
})

test('the capability card carries every field a partner needs to route', () => {
  const c = capabilityCard() as any
  for (const k of ['service', 'version', 'protocols', 'endpoints', 'strengths', 'gaps_we_do_not_fill', 'peers']) {
    assert.ok(c[k] !== undefined, `missing ${k}`)
  }
  assert.ok(c.endpoints.models_public.endsWith('/api/models/public'))
  assert.ok(c.endpoints.agent_card.endsWith('/.well-known/agent-card.json'))
  assert.ok(Array.isArray(c.peers) && c.peers.length >= 1)
})

test('the agent card is peer-addressable', () => {
  const a = agentCard() as any
  assert.equal(a.protocolVersion, '0.2.1')
  assert.equal(a.preferredTransport, 'JSONRPC')
  assert.ok(a.url.endsWith('/a2a'))
  assert.ok(a.skills.length >= 3)
  for (const s of a.skills) {
    assert.ok(s.id && s.name && s.description, 'skill needs id, name, description')
  }
})

test('a2a answers discovery and refuses unknown methods without spending', () => {
  const ok = a2aResponse('message/send', { message: { text: 'hello' } }, 1)
  assert.equal(ok.status, 200)
  const body = ok.body as any
  assert.equal(body.result.status.state, 'completed')
  assert.match(body.result.artifacts[0].parts[0].text, /no inference/i)

  const card = a2aResponse('agent/getCard', {}, 2) as any
  assert.ok(card.body.result.skills)

  const bad = a2aResponse('tasks/get', {}, 3) as any
  assert.equal(bad.body.error.code, -32001)

  const unknown = a2aResponse('does/not/exist', {}, 4) as any
  assert.equal(unknown.body.error.code, -32601)

  const stream = a2aResponse('message/stream', {}, 5) as any
  assert.equal(stream.body.error.code, -32601)
})

test('replay is proof of prior accounting, never a failure', () => {
  const r = classifyVerification({ replay: true, verified: false })
  assert.equal(r.status, 'replay')
  assert.equal(r.replay, true)
  assert.equal(r.verifiedOnchain, true) // accounted for already

  const v = classifyVerification({ data: { verified: true, confirmations: 12 } })
  assert.equal(v.status, 'verified')
  assert.equal(v.confirmations, 12)

  const u = classifyVerification({ verified: false, confirmations: 0 })
  assert.equal(u.status, 'unverified')
})

test('tx hash extraction accepts a header or a decoded payload', () => {
  const h = '0x' + 'ab'.repeat(32)
  assert.equal(txHashFrom(null, `payment-response=${h}`), h)
  assert.equal(txHashFrom({ transaction: h }), h)
  assert.equal(txHashFrom({ txHash: h.toUpperCase().replace('0X', '0x') }), h)
  assert.equal(txHashFrom(null, 'no hash here'), null)
})

test('a 402 carrying a verification payload is still read as a result', async () => {
  // Measured shape from Vesper's verifier: 402 status, full on-chain data attached.
  const body = {
    protocol: 'x402-verifier',
    verified_onchain: false,
    confirmations: 906646,
    block: 53443985,
    tx_hash: '0x' + 'ab'.repeat(32),
    exact_method: { match: false, reason: 'unknown method' },
    errors: [],
  }
  const fields = ['verified_onchain', 'verified', 'confirmations', 'exact_method', 'tx_hash', 'block']
  assert.equal(fields.some((f) => f in body), true, 'payload must be recognised as a result')
  const r = classifyVerification(body)
  assert.equal(r.confirmations, 906646)
  assert.equal(r.verifiedOnchain, false)
})
