process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { Hono } = await import('hono')
const { registerPublicRoutes } = await import('../src/routes/public.js')
const { migrate } = await import('../src/db/index.js')
const { CHANGELOG, SUITE } = await import('../src/data/changelog.js')

function app() {
  const a = new Hono()
  registerPublicRoutes(a as any)
  return a
}

const PATHS = ['/platform', '/docs', '/docs/api', '/docs/mcp', '/docs/x402', '/roadmap', '/partnerships', '/changelog']

test('every public page renders as html with a title', async () => {
  await migrate()
  const a = app()
  for (const path of PATHS) {
    const res = await a.request(path)
    assert.equal(res.status, 200, `${path} should be 200`)
    assert.match(res.headers.get('content-type') || '', /text\/html/, `${path} should be html`)
    const body = await res.text()
    assert.match(body, /<title>[^<]+ · Thirdeye AI<\/title>/, `${path} should carry a page title`)
    assert.match(body, /<nav>/, `${path} should carry the navigation`)
  }
})

test('the status page reports liveness and the suite size without inventing numbers', async () => {
  await migrate()
  const res = await app().request('/status')
  const body = await res.text()
  assert.equal(res.status, 200)
  assert.match(body, /database (up|down|unknown)/)
  assert.ok(body.includes(String(SUITE.tests)), 'suite size should appear')
  assert.ok(body.includes(SUITE.measuredOn), 'suite measurement date should appear')
})

test('the changelog renders real commits and excludes nothing it claims to show', async () => {
  await migrate()
  const body = await (await app().request('/changelog')).text()
  assert.ok(CHANGELOG.length >= 5, 'there should be real history to show')
  for (const entry of CHANGELOG.slice(0, 5)) {
    assert.ok(body.includes(entry.sha), `commit ${entry.sha} should be listed`)
  }
})

test('no public page leaks a credential, a secret name or a private key', async () => {
  await migrate()
  const a = app()
  for (const path of [...PATHS, '/status']) {
    const body = await (await a.request(path)).text()
    for (const forbidden of ['sk-thirdeye', 'MASTER_KEY', 'DATABASE_URL=', 'PRIVY', 'private_key']) {
      assert.ok(!body.includes(forbidden), `${path} leaked ${forbidden}`)
    }
    assert.ok(!/[0-9a-f]{64}/i.test(body), `${path} contains something shaped like a raw key`)
  }
})

test('the docs name the real endpoints rather than a generic promise', async () => {
  await migrate()
  const body = await (await app().request('/docs/api')).text()
  for (const endpoint of ['/api/v1/chat/completions', '/api/v1/models', '/api/keys', '/api/feedback']) {
    assert.ok(body.includes(endpoint), `docs should document ${endpoint}`)
  }
  assert.ok(body.includes('x-thirdeye-cost-usd'), 'docs should name the billing header')
})

test('the partnership page states terms are private and names only disclosed partners', async () => {
  await migrate()
  const body = await (await app().request('/partnerships')).text()
  assert.match(body, /never its terms/i)
  assert.ok(body.includes('Coin Gawd'), 'the disclosed partner should be listed')
})

test('an unknown path is not handled by the public module', async () => {
  await migrate()
  const res = await app().request('/nope-not-a-page')
  assert.equal(res.status, 404)
})
