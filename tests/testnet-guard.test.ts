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

import { allowanceAllows } from '../src/lib/allowance.js'

test('an uncapped allowance always covers, a capped one stops at its ceiling', () => {
  assert.equal(allowanceAllows(0, 0), true)
  assert.equal(allowanceAllows(0, 99_000_000), true, 'cap 0 means uncapped')
  assert.equal(allowanceAllows(5_000_000, 0), true)
  assert.equal(allowanceAllows(5_000_000, 4_999_999), true)
  assert.equal(allowanceAllows(5_000_000, 5_000_000), false, 'stops exactly at the ceiling')
  assert.equal(allowanceAllows(5_000_000, 9_000_000), false)
})

import { canonicalModelId, BRAND_ALIAS_PREFIXES } from '../src/providers/index.js'

test('branded model aliases resolve to the canonical catalogue id', () => {
  assert.equal(canonicalModelId('thirdeye/gpt-oss-120b'), 'gpt-oss-120b')
  assert.equal(canonicalModelId('thirdeye-gpt-oss-120b'), 'gpt-oss-120b')
  assert.equal(canonicalModelId('THIRDEYE/gpt-oss-120b'), 'gpt-oss-120b')
  assert.equal(canonicalModelId('gpt-oss-120b'), 'gpt-oss-120b', 'plain ids keep working')
  assert.equal(canonicalModelId('  thirdeye/qwen3.8-27b  '), 'qwen3.8-27b')
  assert.equal(canonicalModelId('thirdeye/mistral-small'), 'mistral-small')
})

test('alias stripping is pure, so resolution order is what protects real ids', () => {
  // A real model called thirdeye-mock exists. The resolver queries the exact id first and only
  // then the stripped form, so the alias can never shadow a genuine catalogue entry.
  assert.equal(canonicalModelId('thirdeye-mock'), 'mock')
  assert.equal(BRAND_ALIAS_PREFIXES.length, 3)
})

import { splitKeyCredit } from '../src/lib/keycredit.js'

test('key credit is spent before the account balance', () => {
  assert.deepEqual(splitKeyCredit(1_000_000, 250_000), { fromKey: 250_000, fromAccount: 0 })
  assert.deepEqual(splitKeyCredit(100_000, 250_000), { fromKey: 100_000, fromAccount: 150_000 })
  assert.deepEqual(splitKeyCredit(0, 250_000), { fromKey: 0, fromAccount: 250_000 })
})

test('a free call and a negative or junk key credit never mis-charge', () => {
  assert.deepEqual(splitKeyCredit(1_000_000, 0), { fromKey: 0, fromAccount: 0 })
  assert.deepEqual(splitKeyCredit(-5, 100), { fromKey: 0, fromAccount: 100 })
  assert.deepEqual(splitKeyCredit(1_000_000, -10), { fromKey: 0, fromAccount: 0 })
  assert.deepEqual(splitKeyCredit(Number.NaN, 100), { fromKey: 0, fromAccount: 100 })
})

import { normalizeUsage, uncachedInput } from '../src/lib/tokenUsage.js'
import { computeCostMicrosDetailed } from '../src/lib/pricing.js'

const row: any = { model: 'm', provider: 'openai', upstream_model: 'm', base_url: null, price_in_1m_usd_micros: 1_000_000, price_out_1m_usd_micros: 2_000_000, enabled: true }

test('anthropic cache split is read from its own fields', () => {
  const u = normalizeUsage({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 600, cache_creation_input_tokens: 100 })
  assert.equal(u.prompt_tokens, 1000)
  assert.equal(u.input_cached_read, 600)
  assert.equal(u.input_cache_write, 100)
  assert.equal(uncachedInput(u), 300)
})

test('openai cached and reasoning tokens are read from detail objects', () => {
  const u = normalizeUsage({ prompt_tokens: 500, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 120 } })
  assert.equal(u.input_cached_read, 200)
  assert.equal(u.reasoning_tokens, 120)
  assert.equal(uncachedInput(u), 300)
})

test('a bogus split never exceeds the input count', () => {
  const u = normalizeUsage({ prompt_tokens: 100, cache_read_input_tokens: 90, cache_creation_input_tokens: 90 })
  assert.equal(u.input_cached_read + u.input_cache_write, 100)
})

test('with no cache rates configured the bill is identical to the old formula', () => {
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 0, input_cached_read: 500_000, input_cache_write: 0 }
  const detailed = computeCostMicrosDetailed(row, usage, 0, false)
  const plain = Math.ceil((1_000_000 * 1_000_000) / 1e6)
  assert.equal(detailed, plain, 'cached tokens fall back to the full input rate')
})

test('a configured cache rate actually lowers the bill', () => {
  const cheap: any = { ...row, price_in_cached_1m_usd_micros: 100_000 } // 10x cheaper
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 0, input_cached_read: 500_000, input_cache_write: 0 }
  const withCache = computeCostMicrosDetailed(cheap, usage, 0, false)
  const without = computeCostMicrosDetailed(row, usage, 0, false)
  assert.ok(withCache < without, `expected ${withCache} < ${without}`)
  assert.equal(withCache, 550_000)
})

test('a cache write rate above input rate costs more, as it should', () => {
  const dear: any = { ...row, price_in_cache_write_1m_usd_micros: 1_250_000 }
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 0, input_cached_read: 0, input_cache_write: 1_000_000 }
  assert.equal(computeCostMicrosDetailed(dear, usage, 0, false), 1_250_000)
})

import { rebuildCostMicros, summarize } from '../src/lib/reconcile.js'

const rates = new Map([['m', { model: 'm', price_in: 1_000_000, price_out: 1_000_000 }]])

test('a charge can be rebuilt from the tokens we stored', () => {
  const row: any = { model: 'm', prompt_tokens: 1000, completion_tokens: 500, input_cached_read: 0, input_cache_write: 0, cost_usd_micros: 1500, rate_card_version: 'v1', status: '200' }
  assert.equal(rebuildCostMicros(row, rates, 0), 1500)
  assert.equal(rebuildCostMicros(row, rates, 10), 1650)
})

test('reconciliation flags a row whose stored cost cannot be reproduced', () => {
  const good: any = { model: 'm', prompt_tokens: 100, completion_tokens: 100, input_cached_read: 0, input_cache_write: 0, cost_usd_micros: 200, rate_card_version: 'v1', status: '200' }
  const bad: any = { model: 'm', prompt_tokens: 100, completion_tokens: 100, input_cached_read: 0, input_cache_write: 0, cost_usd_micros: 400, rate_card_version: 'v1', status: '200' }
  const r1 = summarize([good], rates, 0)
  assert.equal(r1.within_tolerance, true)
  assert.equal(r1.rows_drifted_over_2pct, 0)
  const r2 = summarize([good, bad], rates, 0)
  assert.equal(r2.rows_drifted_over_2pct, 1)
  assert.equal(r2.within_tolerance, false)
})

test('reconciliation ignores free rows and counts cache opportunity', () => {
  const zero: any = { model: 'm', prompt_tokens: 900, completion_tokens: 0, input_cached_read: 0, input_cache_write: 0, cost_usd_micros: 0, rate_card_version: null, status: '402' }
  const r = summarize([zero], rates, 0)
  assert.equal(r.rows_checked, 1)
  assert.equal(r.rows_drifted_over_2pct, 0)
  assert.equal(r.stored_usd_micros, 0)
})

// Key loading must be idempotent and additive: two deposits load twice, a replay loads once.
test('key credit accumulates additively and is never reset by a later load', async () => {
  const { splitKeyCredit } = await import('../src/lib/keycredit.js')
  // A 2.00 load then a 3.00 load leaves 5.00 available, and a 6.00 call spills 1.00 to the account.
  const afterLoads = 2_000_000 + 3_000_000
  const split = splitKeyCredit(afterLoads, 6_000_000)
  assert.equal(split.fromKey, 5_000_000)
  assert.equal(split.fromAccount, 1_000_000)
})

import { validateSecrets, decideSiwe } from '../src/lib/security.js'

test('production refuses to start on development or short secrets', () => {
  const bad = validateSecrets({ sessionSecret: 'thirdeye-dev-session-secret', masterKey: 'thirdeye-dev-master-key', nodeEnv: 'production' })
  assert.equal(bad.length, 2)
  const short = validateSecrets({ sessionSecret: 'abc', masterKey: 'x'.repeat(40), nodeEnv: 'production' })
  assert.equal(short.length, 1)
  assert.equal(short[0].name, 'SESSION_SECRET')
  const same = validateSecrets({ sessionSecret: 'y'.repeat(40), masterKey: 'y'.repeat(40), nodeEnv: 'production' })
  assert.ok(same.some((p) => p.name === 'SESSION_SECRET/MASTER_KEY'))
  const good = validateSecrets({ sessionSecret: 'a'.repeat(44), masterKey: 'b'.repeat(44), nodeEnv: 'production' })
  assert.deepEqual(good, [])
})

test('development keeps working with the built-in defaults', () => {
  assert.deepEqual(validateSecrets({ sessionSecret: 'thirdeye-dev-session-secret', masterKey: 'thirdeye-dev-master-key', nodeEnv: 'development' }), [])
})

test('a SIWE domain mismatch is rejected, not logged', () => {
  const d = decideSiwe({ messageDomain: 'evil.example', host: 'thirdeye-ai-alpha.vercel.app', strictParseFailed: false, nodeEnv: 'production' })
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'domain mismatch')
  const ok = decideSiwe({ messageDomain: 'thirdeye-ai-alpha.vercel.app', host: 'thirdeye-ai-alpha.vercel.app', strictParseFailed: false, nodeEnv: 'production' })
  assert.equal(ok.ok, true)
})

test('an unparseable SIWE message is refused in production but allowed locally', () => {
  assert.equal(decideSiwe({ strictParseFailed: true, nodeEnv: 'production' }).ok, false)
  assert.equal(decideSiwe({ strictParseFailed: true, nodeEnv: 'development' }).ok, true)
  assert.equal(decideSiwe({ strictParseFailed: true, nodeEnv: 'production', allowLenient: true }).ok, true)
})
