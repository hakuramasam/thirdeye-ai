process.env.PGLITE_DIR = 'memory://'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { migrate, query, one } = await import('../src/db/index.js')
const { Hono } = await import('hono')
const { registerV1Routes } = await import('../src/routes/v1.js')
const { createApiKey } = await import('../src/lib/keys.js')
const { encryptSecret, newId } = await import('../src/lib/env.js')
const { adjustCredit, getBalanceMicros } = await import('../src/lib/billing.js')

test('HAKU Gateway Module A Tests', async (t) => {
  await migrate()

  // Setup test user
  const userId = 'user_' + newId()
  await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, '0x' + newId().padEnd(40, '0')])

  // Create API key
  const { secret: keySecret, row: keyRow } = await createApiKey(userId, 'test-key', 60, 250000)

  const app = new Hono()
  registerV1Routes(app as any)

  await t.test('(a) non-stream chat completion with haku-mock', async () => {
    const res = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keySecret}`,
      },
      body: JSON.stringify({
        model: 'haku-mock',
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    })

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('X-Haku-Byok'), 'false')
    assert.equal(res.headers.get('X-Haku-Model'), 'haku-mock')

    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.ok(body.choices[0].message.content.startsWith('MOCK: hello world'))

    // Verify usage recorded
    const usageRow = await one('SELECT * FROM usage_events WHERE user_id = $1 AND model = $2', [userId, 'haku-mock'])
    assert.ok(usageRow)
    assert.equal(Number(usageRow.cost_usd_micros), 0)
  })

  await t.test('(b) stream=true chat completion parsing SSE lines', async () => {
    const res = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keySecret}`,
      },
      body: JSON.stringify({
        model: 'haku-mock',
        messages: [{ role: 'user', content: 'stream test' }],
        stream: true,
      }),
    })

    assert.equal(res.status, 200)
    assert.ok(res.headers.get('Content-Type')?.includes('text/event-stream'))

    const text = await res.text()
    assert.ok(text.includes('data: {"id":'))
    assert.ok(text.includes('data: [DONE]'))

    const lines = text.split('\n').filter((l) => l.startsWith('data: '))
    assert.ok(lines.length >= 4)
  })

  await t.test('(c) GET /api/v1/models lists haku-mock and gpt-4o-mini', async () => {
    const res = await app.request('/api/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${keySecret}`,
      },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'list')
    const modelIds = body.data.map((m: any) => m.id)
    assert.ok(modelIds.includes('haku-mock'))
    assert.ok(modelIds.includes('gpt-4o-mini'))
  })

  await t.test('(d) bad bearer key returns 401', async () => {
    const res = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-haku-invalidkey1234567890',
      },
      body: JSON.stringify({
        model: 'haku-mock',
        messages: [{ role: 'user', content: 'test' }],
      }),
    })

    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error.code, 401)
  })

  await t.test('(e) unknown model returns 404', async () => {
    const res = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keySecret}`,
      },
      body: JSON.stringify({
        model: 'unknown-super-model-xyz',
        messages: [{ role: 'user', content: 'test' }],
      }),
    })

    assert.equal(res.status, 404)
  })

  await t.test('(f) rate limit enforcement and Retry-After header', async () => {
    const { secret: rlKeySecret, row: rlKeyRow } = await createApiKey(userId, 'rl-key', 2, 250000)

    const req = () =>
      app.request('/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rlKeySecret}`,
        },
        body: JSON.stringify({
          model: 'haku-mock',
          messages: [{ role: 'user', content: 'rate limit test' }],
        }),
      })

    const r1 = await req()
    assert.equal(r1.status, 200)

    const r2 = await req()
    assert.equal(r2.status, 200)

    const r3 = await req()
    assert.equal(r3.status, 429)
    assert.ok(r3.headers.get('Retry-After'))
    const body3 = await r3.json()
    assert.equal(body3.error.type, 'rate_limit')
  })

  await t.test('(g) BYOK resolution returns X-Haku-Byok true', async () => {
    const byokUserId = 'user_byok_' + newId()
    await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [byokUserId, '0x' + newId().padEnd(40, '0')])
    const { secret: byokKeySecret } = await createApiKey(byokUserId, 'byok-user-key', 60, 250000)

    await query('INSERT INTO byok_keys (id, user_id, provider, key_ciphertext) VALUES ($1, $2, $3, $4)', [
      newId(),
      byokUserId,
      'mock',
      encryptSecret('mock-secret-key'),
    ])

    const res = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${byokKeySecret}`,
      },
      body: JSON.stringify({
        model: 'haku-mock',
        messages: [{ role: 'user', content: 'byok test' }],
      }),
    })

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('X-Haku-Byok'), 'true')
  })

  await t.test('(h) billing check for paid model and credit adjustment', async () => {
    const paidUserId = 'user_paid_' + newId()
    await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [paidUserId, '0x' + newId().padEnd(40, '0')])
    const { secret: paidKeySecret } = await createApiKey(paidUserId, 'paid-user-key', 60, 250000)

    await query(
      `INSERT INTO models_catalog (model, provider, upstream_model, price_in_1m_usd_micros, price_out_1m_usd_micros)
       VALUES ('paid-mock', 'mock', 'haku-mock', 1000000, 1000000)
       ON CONFLICT (model) DO UPDATE SET price_in_1m_usd_micros = 1000000, price_out_1m_usd_micros = 1000000`,
      []
    )

    // Initial balance is 0, request should fail with 402 billing error
    const res1 = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${paidKeySecret}`,
      },
      body: JSON.stringify({
        model: 'paid-mock',
        messages: [{ role: 'user', content: 'paid test' }],
      }),
    })

    assert.equal(res1.status, 402)
    const body1 = await res1.json()
    assert.equal(body1.error.type, 'billing')

    // Top up balance by 5,000,000 micros ($5.00)
    await adjustCredit(paidUserId, 5000000, 'test topup')

    const res2 = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${paidKeySecret}`,
      },
      body: JSON.stringify({
        model: 'paid-mock',
        messages: [{ role: 'user', content: 'paid test' }],
      }),
    })

    assert.equal(res2.status, 200)
    const costHeader = res2.headers.get('X-Haku-Cost-Usd')
    assert.ok(costHeader)
    assert.ok(Number(costHeader) > 0)

    const finalBalance = await getBalanceMicros(paidUserId)
    assert.ok(finalBalance < 5000000)
  })
})
