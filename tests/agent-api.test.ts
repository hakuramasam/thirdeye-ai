process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { Hono } = await import('hono')
const { registerAgentApiRoutes, slugify, validateAgent } = await import('../src/routes/agentApi.js')
const { migrate, query, one } = await import('../src/db/index.js')
const { createApiKey } = await import('../src/lib/keys.js')
const { newId } = await import('../src/lib/env.js')

async function freshUser(wallet = '0x' + 'ab'.repeat(20)) {
  const id = newId()
  await query(`INSERT INTO users (id, wallet, role) VALUES ($1,$2,'user')`, [id, wallet])
  return id
}

function app() {
  const a = new Hono()
  registerAgentApiRoutes(a as any)
  return a
}

const GOOD = {
  name: 'Ledger Owl',
  description: 'Watches onchain transfer logs and reports anomalies to its owner twice an hour.',
  capabilities: ['log-watch', 'anomaly-report'],
  homepage: 'https://example.com/agents/ledger-owl',
}

test('slugs are lowercase, hyphenated and never empty', () => {
  assert.equal(slugify('Ledger Owl'), 'ledger-owl')
  assert.equal(slugify('  --Weird   Name!!  '), 'weird-name')
  assert.equal(slugify('###'), 'agent')
  assert.ok(slugify('x'.repeat(80)).length <= 48)
})

test('registration validation rejects weak descriptions and unsafe URLs', () => {
  assert.equal(validateAgent(GOOD).ok, true)
  assert.equal(validateAgent({ ...GOOD, description: 'too short' }).ok, false)
  assert.equal(validateAgent({ ...GOOD, name: 'x' }).ok, false)
  assert.equal(validateAgent({ ...GOOD, capabilities: 'not-a-list' }).ok, false)
  assert.equal(validateAgent({ ...GOOD, capabilities: Array.from({ length: 13 }, (_, i) => `c${i}`) }).ok, false)

  const http = validateAgent({ ...GOOD, homepage: 'http://example.com' })
  assert.equal(http.ok, false, 'plain http must be refused')

  const local = validateAgent({ ...GOOD, homepage: 'https://localhost:3000/x' })
  assert.equal(local.ok, false, 'localhost must be refused')

  const literal = validateAgent({ ...GOOD, callbackUrl: 'https://10.0.0.5/hook' })
  assert.equal(literal.ok, false, 'an IP literal must be refused')

  const withQuery = validateAgent({ ...GOOD, callbackUrl: 'https://example.com/hook?token=abc' })
  assert.equal(withQuery.ok, false, 'a query string must be refused')
})

test('registration needs a caller, issues one key, and bills the owner', async () => {
  await migrate()
  const a = app()
  const unauth = await a.request('/api/v1/agents/register', { method: 'POST', body: JSON.stringify(GOOD) })
  assert.equal(unauth.status, 401)

  const userId = await freshUser()
  const { secret } = await createApiKey(userId, 'owner key', 60, 250000, null)
  const res = await a.request('/api/v1/agents/register', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify(GOOD),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.agent.slug, 'ledger-owl')
  assert.ok(body.key.secret.startsWith('sk-thirdeye-'), 'the response carries the key secret once')
  assert.match(body.billing, /bills your account/i, 'the billing basis must be stated, not implied')

  const row = await one(`SELECT owner_user_id, status FROM agent_identities WHERE slug = 'ledger-owl'`)
  assert.equal(row.owner_user_id, userId)
  assert.equal(row.status, 'active')

  const linked = await one(`SELECT agent_identity_id FROM api_keys WHERE key_hash = $1`, [
    (await import('../src/lib/keys.js')).hashSecret(body.key.secret),
  ])
  assert.ok(linked.agent_identity_id, 'the issued key must be bound to the identity')
})

test('two agents may share a name and get distinct slugs', async () => {
  await migrate()
  const a = app()
  const userId = await freshUser('0x' + 'cd'.repeat(20))
  const { secret } = await createApiKey(userId, 'owner two', 60, 250000, null)
  const first = await a.request('/api/v1/agents/register', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(GOOD) })
  assert.equal(first.status, 201)
  const second = await a.request('/api/v1/agents/register', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(GOOD) })
  assert.equal(second.status, 201)
  const slugTwo = (await second.json()).agent.slug
  assert.notEqual(slugTwo, 'ledger-owl')
  assert.match(slugTwo, /^ledger-owl-[0-9a-z]{4}$/, 'a collision takes a random suffix, not a counter')
})

test('a plain user key is refused on the identity endpoints', async () => {
  await migrate()
  const userId = await freshUser('0x' + 'ef'.repeat(20))
  const { secret } = await createApiKey(userId, 'plain key', 60, 250000, null)
  const res = await app().request('/api/v1/agents/me', { headers: { authorization: `Bearer ${secret}` } })
  assert.equal(res.status, 403)
})

test('the identity can read itself, edit itself, and retire itself', async () => {
  await migrate()
  const a = app()
  const userId = await freshUser('0x' + '12'.repeat(20))
  const { secret: ownerKey } = await createApiKey(userId, 'owner three', 60, 250000, null)
  const uniq = { ...GOOD, name: 'Identity Probe' }
  const reg = await a.request('/api/v1/agents/register', { method: 'POST', headers: { authorization: `Bearer ${ownerKey}` }, body: JSON.stringify(uniq) })
  const agentKey = (await reg.json()).key.secret

  const me = await a.request('/api/v1/agents/me', { headers: { authorization: `Bearer ${agentKey}` } })
  assert.equal(me.status, 200)
  const meBody = await me.json()
  assert.equal(meBody.agent.slug, 'identity-probe')
  assert.equal(meBody.usage.calls, 0)
  assert.equal(meBody.agent.callback_url, null)

  const patched = await a.request('/api/v1/agents/me', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${agentKey}` },
    body: JSON.stringify({ description: 'Now watches mempool too, and files a short digest every six hours.' }),
  })
  assert.equal(patched.status, 200)
  assert.match((await patched.json()).agent.description, /mempool/)

  // A partial edit that would break a rule must still be refused.
  const badPatch = await a.request('/api/v1/agents/me', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${agentKey}` },
    body: JSON.stringify({ description: 'short' }),
  })
  assert.equal(badPatch.status, 400)

  const retired = await a.request('/api/v1/agents/me', { method: 'DELETE', headers: { authorization: `Bearer ${agentKey}` } })
  assert.equal(retired.status, 200)
  const after = await one(`SELECT status FROM agent_identities WHERE slug = 'identity-probe'`)
  assert.equal(after.status, 'retired')

  const dead = await a.request('/api/v1/agents/me', { headers: { authorization: `Bearer ${agentKey}` } })
  assert.equal(dead.status, 403, 'a retired identity must stop resolving')
})

test('the directory shows active identities only and never their owner or spend', async () => {
  await migrate()
  const a = app()
  const userId = await freshUser('0x' + '34'.repeat(20))
  await query(
    `INSERT INTO agent_identities (id, owner_user_id, slug, name, description, capabilities, status)
     VALUES ($1,$2,'active-one','Active One','A visible agent used to check the directory listing.', '["a"]','active'),
            ($3,$2,'retired-one','Retired One','A retired agent that must never appear in the directory.', '[]','retired')`,
    [newId(), userId, newId()]
  )
  const res = await a.request('/api/v1/agents/directory')
  const body = await res.json()
  const slugs = body.agents.map((x: any) => x.slug)
  assert.ok(slugs.includes('active-one'))
  assert.ok(!slugs.includes('retired-one'))
  const raw = JSON.stringify(body)
  assert.ok(!raw.includes(userId), 'the owner id must not be published')
  assert.ok(!raw.includes('0x34'), 'the owner wallet must not be published')
  assert.ok(!raw.includes('sk-thirdeye'), 'no key material may appear')
})
