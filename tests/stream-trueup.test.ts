process.env.PGLITE_DIR = 'memory://'
// Needed so a non-BYOK upstream can be resolved and then fail during the stream itself.
process.env.PROV_OPENAI_API_KEY = 'test-openai-key'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { migrate, query, one } = await import('../src/db/index.js')
const { Hono } = await import('hono')
const { registerV1Routes } = await import('../src/routes/v1.js')
const { createApiKey } = await import('../src/lib/keys.js')
const { newId } = await import('../src/lib/env.js')
const { adjustCredit, getBalanceMicros } = await import('../src/lib/billing.js')
const { getKeyCreditMicros } = await import('../src/lib/keycredit.js')
const { createStreamAccountant } = await import('../src/lib/streamAccounting.js')

/**
 * Streaming settlement must be part of the response, not a task the runtime may drop.
 *
 * Production serves the app through `handle(app)` from `hono/vercel`, which calls
 * `app.fetch(req)` with no ExecutionContext. `c.executionCtx` therefore throws on every
 * request, and the old accounting promise was fire-and-forget: the reserve stayed on the books
 * and the measured cost never replaced it. These tests assert the settlement has already
 * happened by the time the caller has read the last byte, which is the only property that makes
 * the figure trustworthy on a runtime that freezes once the response completes.
 */

const MICROS_PER_TOKEN = 10 // price_in/out 10_000_000 per 1M tokens
let userSeq = 0

async function makePayer(app: any) {
  const userId = 'user_stream_' + newId() + '_' + userSeq++
  await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, '0x' + newId().padEnd(40, '0')])
  const { secret, row } = await createApiKey(userId, 'stream-key', 60, 250000)
  return { userId, secret, keyId: row.id }
}

async function ensureModel(model: string) {
  await query(
    `INSERT INTO models_catalog (model, provider, upstream_model, price_in_1m_usd_micros, price_out_1m_usd_micros)
     VALUES ($1, 'mock', 'thirdeye-mock', 10000000, 10000000)
     ON CONFLICT (model) DO UPDATE SET price_in_1m_usd_micros = 10000000, price_out_1m_usd_micros = 10000000`,
    [model]
  )
}

async function streamCall(app: any, secret: string, model: string, extra: Record<string, any> = {}) {
  return app.request('/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'stream settlement test' }],
      stream: true,
      ...extra,
    }),
  })
}

test('streaming settles inside the response stream', async (t) => {
  await migrate()
  const app = new Hono()
  registerV1Routes(app as any)

  await t.test('the true-up lands before the caller finishes reading (no waitUntil)', async () => {
    const { userId, secret } = await makePayer(app)
    await ensureModel('paid-stream-a')
    await adjustCredit(userId, 5_000_000, 'test-funding')
    const before = await getBalanceMicros(userId)

    const res = await streamCall(app, secret, 'paid-stream-a')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('X-Thirdeye-Cost-Basis'), 'estimate')
    const text = await res.text()
    assert.ok(text.includes('[DONE]'))

    // No sleep, no polling: if the settlement were still a detached promise this would fail.
    const ledger = await query('SELECT ref, amount_usd_micros FROM ledger WHERE user_id = $1 ORDER BY id', [userId])
    const refs = ledger.rows.map((r: any) => r.ref)
    const settled = refs.some((r: string) => String(r || '').startsWith('stream-trueup'))
    assert.ok(settled, `expected a stream-trueup row, got ${JSON.stringify(refs)}`)

    const usage = await one('SELECT cost_usd_micros, status, prompt_tokens, completion_tokens FROM usage_events WHERE user_id = $1', [userId])
    assert.equal(usage.status, 'stream')

    const after = await getBalanceMicros(userId)
    assert.equal(before - after, Number(usage.cost_usd_micros), 'net charge must equal the measured cost')
    assert.ok(Number(usage.completion_tokens) > 0)
  })

  await t.test('a completion that outgrows the reserve is charged the difference', async () => {
    const { userId, secret } = await makePayer(app)
    await ensureModel('paid-stream-b')
    await adjustCredit(userId, 5_000_000, 'test-funding')
    const before = await getBalanceMicros(userId)

    // max_tokens 1 makes the up-front estimate smaller than the 7 tokens the mock returns.
    const res = await streamCall(app, secret, 'paid-stream-b', { max_tokens: 1 })
    assert.equal(res.status, 200)
    const reservedMicros = Math.round(Number(res.headers.get('X-Thirdeye-Cost-Usd')) * 1e6)
    await res.text()

    const ledger = await query('SELECT ref, kind, amount_usd_micros FROM ledger WHERE user_id = $1 ORDER BY id', [userId])
    const debit = ledger.rows.find((r: any) => String(r.ref || '').startsWith('stream-trueup:'))
    assert.ok(debit, 'expected an extra charge, not a refund')

    const usage = await one('SELECT cost_usd_micros FROM usage_events WHERE user_id = $1', [userId])
    const measured = Number(usage.cost_usd_micros)
    assert.ok(measured > reservedMicros, `measured ${measured} should exceed reserve ${reservedMicros}`)
    assert.equal(before - (await getBalanceMicros(userId)), measured)
  })

  await t.test('key-scoped credit pays the stream and the refund returns to the key', async () => {
    const userId = 'user_stream_key_' + newId()
    await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, '0x' + newId().padEnd(40, '0')])
    const { secret, row: keyRow } = await createApiKey(userId, 'key-funded', 60, 250000)
    await ensureModel('paid-stream-c')

    await query('UPDATE api_keys SET credit_usd_micros = 200000 WHERE id = $1', [keyRow.id])

    const res = await streamCall(app, secret, 'paid-stream-c')
    assert.equal(res.status, 200)
    await res.text()

    const usage = await one('SELECT cost_usd_micros FROM usage_events WHERE user_id = $1', [userId])
    const remaining = await getKeyCreditMicros(keyRow.id)
    assert.equal(200000 - remaining, Number(usage.cost_usd_micros), 'the over-reserve must come back to the key')
  })

  await t.test('an upstream that never streams refunds the reserve instead of charging for it', async () => {
    const userId = 'user_stream_fail_' + newId()
    await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, '0x' + newId().padEnd(40, '0')])
    const { secret } = await createApiKey(userId, 'failing', 60, 250000)
        await adjustCredit(userId, 5_000_000, 'test-funding')
    const before = await getBalanceMicros(userId)

    // A real upstream that cannot be reached: the reserve is taken first, then the stream call
    // fails, which is exactly the case the refund exists for.
    await query(
      `INSERT INTO models_catalog (model, provider, upstream_model, base_url, price_in_1m_usd_micros, price_out_1m_usd_micros)
       VALUES ('paid-stream-fail', 'openai', 'gpt-x', 'http://127.0.0.1:1', 10000000, 10000000)
       ON CONFLICT (model) DO UPDATE SET base_url = 'http://127.0.0.1:1'`,
      []
    )
    const res = await streamCall(app, secret, 'paid-stream-fail')
    assert.ok(res.status >= 400, `expected an upstream failure, got ${res.status}`)
    await res.text()

    const refunded = await query(
      "SELECT ref FROM ledger WHERE user_id = $1 AND ref = 'stream-reserve-refund'",
      [userId]
    )
    assert.equal(refunded.rows.length, 1, 'the reserve must be refunded')
    assert.equal(before - (await getBalanceMicros(userId)), 0, 'a failed stream must not cost anything')
  })

  await t.test('a caller who hangs up settles what was actually streamed', async () => {
    const userId = 'user_stream_abort_' + newId()
    await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, '0x' + newId().padEnd(40, '0')])
    const { row: keyRow } = await createApiKey(userId, 'abort-key', 60, 250000)

    const modelRow = {
      model: 'paid-stream-e',
      provider: 'mock',
      upstream_model: 'thirdeye-mock',
      base_url: null,
      price_in_1m_usd_micros: 10000000,
      price_out_1m_usd_micros: 10000000,
      enabled: true,
    }
    const accountant = createStreamAccountant({
      userId,
      wallet: '0x' + newId().padEnd(40, '0'),
      apiKey: { ...keyRow, budget_usd_micros: null },
      modelRow: modelRow as any,
      requestedModel: 'paid-stream-e',
      provider: 'mock',
      byok: false,
      marginPct: 10,
      estTokens: 4,
      reservedMicros: 0,
      reservedFromKey: 0,
      startedAt: Date.now(),
      rateCardVersion: 'test',
    })

    const writer = accountant.transform.writable.getWriter()
    const reader = accountant.transform.readable.getReader()
    void reader.read()
    await writer.write(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'))
    // The caller hangs up mid-answer.
    await reader.cancel()
    await writer.close().catch(() => {})

    const settlement = await accountant.done
    assert.equal(settlement.settled, true)
    assert.equal(settlement.usage_source, 'chars')
    const usage = await one('SELECT status FROM usage_events WHERE user_id = $1', [userId])
    assert.equal(usage.status, 'stream')
  })
})
