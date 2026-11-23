import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/worker.js'

const assets = { fetch: async () => new Response('frontend', { status: 200 }) }
const env = {
  ASSETS: assets,
  ENVIRONMENT: 'staging',
  STAGING_DATABASE_ENABLED: 'false',
  LIVE_PAYMENTS_ENABLED: 'false',
  AGENT_EXECUTION_ENABLED: 'false',
}

test('liveness is available without a database', async () => {
  const response = await worker.fetch(new Request('https://staging.example/api/livez'), env as never, {} as never)
  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.databaseWrites, false)
  assert.equal(body.livePayments, false)
  assert.equal(body.productionAgentExecution, false)
})

test('readiness fails closed until isolated staging database is integrated', async () => {
  const response = await worker.fetch(new Request('https://staging.example/api/healthz'), env as never, {} as never)
  assert.equal(response.status, 503)
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.database, 'not-configured')
})

test('all API routes remain disabled in staging', async () => {
  const response = await worker.fetch(new Request('https://staging.example/api/credits'), env as never, {} as never)
  assert.equal(response.status, 503)
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.error, 'staging_api_not_migrated')
})

test('non-API requests are served by the static assets binding', async () => {
  const response = await worker.fetch(new Request('https://staging.example/dashboard'), env as never, {} as never)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'frontend')
})
