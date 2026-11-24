process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query } = await import('../src/db/index.js')
const { recordUsage, getUserUsageSeries } = await import('../src/lib/usage.js')
const { hasProviderUsage, normalizeUsage } = await import('../src/lib/tokenUsage.js')
const { Hono } = await import('hono')
const { registerStatsRoutes } = await import('../src/routes/stats.js')

await migrate()

const userId = `usage-provenance-${randomUUID()}`
const base = {
  user_id: userId,
  api_key_id: 'usage-provenance-key',
  model: 'thirdeye-mock',
  provider: 'mock',
  byok: false,
  cost_usd_micros: 0,
  latency_ms: 1,
}

test('actual, estimated and legacy-unclassified tokens remain separate', async () => {
  await recordUsage({
    ...base,
    prompt_tokens: 120,
    completion_tokens: 30,
    usage_source: 'provider',
    cost_usd_micros: 15,
    status: '200',
  })

  await recordUsage({
    ...base,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_prompt_tokens: 2000,
    estimated_completion_tokens: 0,
    usage_source: 'estimate',
    status: '429',
  })

  await recordUsage({
    ...base,
    prompt_tokens: 40,
    completion_tokens: 20,
    usage_source: 'mock',
    status: '200',
  })

  // Historical rows have no provenance. They remain visible as unclassified rather than
  // being silently presented as provider-reported usage.
  await recordUsage({
    ...base,
    prompt_tokens: 7,
    completion_tokens: 3,
    status: '200',
  })

  const series = await getUserUsageSeries(userId, 1)
  assert.equal(series.length, 1)
  assert.equal(series[0].tokens, 2220)
  assert.equal(series[0].provider_reported_tokens, 150)
  assert.equal(series[0].mock_tokens, 60)
  assert.equal(series[0].estimated_tokens, 2000)
  assert.equal(series[0].unclassified_tokens, 10)
  assert.equal(series[0].cost_usd_micros, 15)

  const rows = await query(
    `SELECT usage_source, prompt_tokens, completion_tokens,
            estimated_prompt_tokens, estimated_completion_tokens
       FROM usage_events WHERE user_id = $1 ORDER BY id ASC`,
    [userId],
  )
  assert.deepEqual(rows.rows.map((r: any) => r.usage_source), ['provider', 'estimate', 'mock', 'unknown'])
  assert.equal(Number(rows.rows[1].prompt_tokens), 0)
  assert.equal(Number(rows.rows[1].estimated_prompt_tokens), 2000)

  const statsApp = new Hono()
  registerStatsRoutes(statsApp as any)
  const response = await statsApp.request('/api/stats/public')
  assert.equal(response.status, 200)
  const publicStats = await response.json() as any
  assert.equal(publicStats.totals.tokens, 2220)
  assert.equal(publicStats.totals.provider_reported_tokens, 150)
  assert.equal(publicStats.totals.mock_tokens, 60)
  assert.equal(publicStats.totals.estimated_tokens, 2000)
  assert.equal(publicStats.totals.unclassified_tokens, 10)
  const today = new Date().toISOString().slice(0, 10)
  const todayStats = publicStats.series.find((day: any) => day.day === today)
  assert.ok(todayStats)
  assert.equal(todayStats.provider_reported_tokens, 150)
  assert.equal(todayStats.mock_tokens, 60)

  await assert.rejects(
    query(
      `INSERT INTO usage_events (user_id, api_key_id, model, provider, byok, prompt_tokens, completion_tokens, usage_source, cost_usd_micros, status, latency_ms)
       VALUES ($1, 'bad-key', 'bad-model', 'bad-provider', false, 1, 1, 'invalid-source', 0, '200', 1)`,
      [userId],
    ),
    /usage_events_usage_source_check/,
  )
})

test('provider usage detection accepts OpenAI and Anthropic token field names', () => {
  assert.equal(hasProviderUsage({ prompt_tokens: 12, completion_tokens: 8 }), true)
  assert.equal(hasProviderUsage({ input_tokens: 12, output_tokens: 8 }), true)
  assert.equal(hasProviderUsage({ prompt_tokens: 12 }), false)
  assert.equal(hasProviderUsage(null), false)

  const anthropic = normalizeUsage({ input_tokens: 12, output_tokens: 8 })
  assert.equal(anthropic.prompt_tokens, 12)
  assert.equal(anthropic.completion_tokens, 8)
})
