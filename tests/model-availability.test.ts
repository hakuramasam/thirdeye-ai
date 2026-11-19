// Availability is what tells a caller the difference between "pick another model" and "bring
// your own key". The catalogue used to answer neither, so an integration reasonably concluded
// the platform needed a provider key it did not have. These tests pin both halves: the pure
// derivation rules, and the endpoint and error a caller actually receives.

process.env.PGLITE_DIR = 'memory://'
// A platform key for a probe provider, set before src/lib/env.ts is loaded: env.providerKeys is
// built once at import, so this is the only point where a test can influence it.
process.env.PROV_PROBE_API_KEY = 'probe-key-not-a-real-secret'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { providerNameFor, modelAvailability, cheapestAvailable, availableModelIds, isAutoAlias } =
  await import('../src/lib/availability.js')
const { migrate, query, one } = await import('../src/db/index.js')
const { Hono } = await import('hono')
const { registerV1Routes } = await import('../src/routes/v1.js')
const { createApiKey } = await import('../src/lib/keys.js')
const { adjustCredit } = await import('../src/lib/billing.js')
const { newId } = await import('../src/lib/env.js')
const { env } = await import('../src/lib/env.js')

function row(over: Record<string, any> = {}) {
  return {
    model: 'm',
    provider: 'openai-compatible',
    upstream_model: 'm',
    base_url: 'https://api.vendor.com/v1',
    price_in_1m_usd_micros: 100,
    price_out_1m_usd_micros: 200,
    enabled: true,
    ...over,
  } as any
}

test('provider name derivation', async (t) => {
  await t.test('native providers keep their declared name', () => {
    assert.equal(providerNameFor(row({ provider: 'openai' })), 'openai')
    assert.equal(providerNameFor(row({ provider: 'anthropic' })), 'anthropic')
    assert.equal(providerNameFor(row({ provider: 'mock', base_url: null })), 'mock')
  })

  await t.test('the providers we already serve derive the names their keys are stored under', () => {
    assert.equal(providerNameFor(row({ base_url: 'https://api.groq.com/openai/v1' })), 'groq')
    assert.equal(providerNameFor(row({ base_url: 'https://api.mistral.ai/v1' })), 'mistral')
    assert.equal(providerNameFor(row({ base_url: 'https://api.deepseek.com/v1' })), 'deepseek')
    assert.equal(providerNameFor(row({ base_url: 'https://openrouter.ai/api/v1' })), 'openrouter')
  })

  await t.test('a multi-label host cannot produce a name no environment variable could match', () => {
    const name = providerNameFor(row({ base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' }))
    assert.equal(name, 'generativelanguage')
    assert.match(name, /^[a-z0-9]+$/, 'PROV_([A-Z0-9]+)_API_KEY can only match alphanumerics')
  })

  await t.test('a missing or unusable base URL falls back to the declared provider, sanitised', () => {
    assert.equal(providerNameFor(row({ provider: 'openai-compatible', base_url: null })), 'openaicompatible')
    assert.equal(providerNameFor(row({ provider: 'Some-Vendor', base_url: 'not a url' })), 'somevendor')
  })
})

test('availability rules', async (t) => {
  const keys = { groq: 'k' }

  await t.test('funded provider is available, unfunded one is not and says why', () => {
    const funded = modelAvailability(row({ base_url: 'https://api.groq.com/openai/v1' }), keys)
    assert.deepEqual(funded, { provider: 'groq', available: true, byok_supported: true })

    const unfunded = modelAvailability(row({ base_url: 'https://api.mistral.ai/v1' }), keys)
    assert.equal(unfunded.available, false)
    assert.equal(unfunded.byok_supported, true, 'a caller can still serve it with their own key')
    assert.equal(unfunded.unavailable_reason, 'no_platform_key')
  })

  await t.test('mock is servable without any key, and offers no BYOK', () => {
    const a = modelAvailability(row({ provider: 'mock', base_url: null }), {})
    assert.equal(a.available, true)
    assert.equal(a.byok_supported, false)
  })

  await t.test('a disabled row is unavailable even with a key present', () => {
    const a = modelAvailability(row({ base_url: 'https://api.groq.com/openai/v1', enabled: false }), keys)
    assert.equal(a.available, false)
    assert.equal(a.unavailable_reason, 'disabled')
  })
})

test('auto model selection', async (t) => {
  await t.test('alias forms are recognised and other ids are not', () => {
    for (const alias of ['auto', 'AUTO', ' auto ', 'thirdeye/auto', 'thirdeye-auto', 'thirdeye_auto']) {
      assert.equal(isAutoAlias(alias), true, alias)
    }
    for (const other of ['autopilot', 'gpt-oss-120b', '', 'thirdeye/autopilot']) {
      assert.equal(isAutoAlias(other), false, other)
    }
  })

  await t.test('picks the cheapest servable model and never the mock', () => {
    const keys = { groq: 'k' }
    const models = [
      row({ model: 'mock', provider: 'mock', base_url: null, price_in_1m_usd_micros: 0, price_out_1m_usd_micros: 0 }),
      row({ model: 'expensive', base_url: 'https://api.groq.com/openai/v1', price_in_1m_usd_micros: 900, price_out_1m_usd_micros: 900 }),
      row({ model: 'cheap', base_url: 'https://api.groq.com/openai/v1', price_in_1m_usd_micros: 10, price_out_1m_usd_micros: 10 }),
      row({ model: 'unfunded', base_url: 'https://api.mistral.ai/v1', price_in_1m_usd_micros: 1, price_out_1m_usd_micros: 1 }),
    ]
    assert.equal(cheapestAvailable(models, keys)?.model, 'cheap')
  })

  await t.test('ties break on id so the same catalogue always answers the same way', () => {
    const keys = { groq: 'k' }
    const models = [
      row({ model: 'bbb', base_url: 'https://api.groq.com/openai/v1', price_in_1m_usd_micros: 5, price_out_1m_usd_micros: 5 }),
      row({ model: 'aaa', base_url: 'https://api.groq.com/openai/v1', price_in_1m_usd_micros: 5, price_out_1m_usd_micros: 5 }),
    ]
    assert.equal(cheapestAvailable(models, keys)?.model, 'aaa')
    assert.equal(cheapestAvailable(models.slice().reverse(), keys)?.model, 'aaa')
  })

  await t.test('no servable model returns null rather than the mock', () => {
    const models = [
      row({ model: 'mock', provider: 'mock', base_url: null, price_in_1m_usd_micros: 0, price_out_1m_usd_micros: 0 }),
      row({ model: 'silent', base_url: 'https://api.mistral.ai/v1' }),
    ]
    assert.equal(cheapestAvailable(models, {}), null)
    assert.deepEqual(availableModelIds(models, {}), [], 'the mock is never offered as a substitute')
  })
})

test('catalogue endpoint and refusal', async (t) => {
  await migrate()

  // A servable probe provider, so `auto` has something other than the mock to resolve to. The
  // host is api.probe.test, which derives the provider name "probe" (the key set at the top of
  // this file) and is a reserved name that never resolves: the call is expected to fail at the
  // network, and what is asserted is that it failed on the resolved model, not on the word "auto".
  await query(
    `INSERT INTO models_catalog (model, provider, upstream_model, base_url, price_in_1m_usd_micros, price_out_1m_usd_micros)
     VALUES ('auto-probe', 'openai-compatible', 'auto-probe', 'http://api.probe.test/v1', 1, 1)`
  )

  const userId = 'user_' + newId()
  await query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, '0x' + newId().padEnd(40, '0')])
  // Funded, so the auto call reaches the provider instead of stopping at the balance check.
  await adjustCredit(userId, 1_000_000, 'availability test topup')
  const { secret } = await createApiKey(userId, 'availability-key', 60, 250000)

  const app = new Hono()
  registerV1Routes(app as any)

  const get = () =>
    app.request('/api/v1/models', { headers: { Authorization: `Bearer ${secret}` } })
  const getJson = async (): Promise<any> => (await get()).json()

  await t.test('(a) every catalogue row reports availability consistent with the configured keys', async () => {
    const res = await get()
    assert.equal(res.status, 200)
    const body: any = await res.json()
    const rows = body.data as any[]
    assert.ok(rows.length >= 10)

    for (const m of rows) {
      if (m.id === 'auto') continue
      const keyVar = m.provider_key_var as string
      assert.match(keyVar, /^PROV_[A-Z0-9]+_API_KEY$/, `${m.id} must name a variable the loader can read`)
      if (m.owned_by_upstream === 'mock') {
        assert.equal(m.available, true)
        continue
      }
      assert.equal(m.available, Boolean(process.env[keyVar]), `${m.id} availability must follow ${keyVar}`)
      if (!m.available) assert.equal(m.unavailable_reason, 'no_platform_key')
    }
  })

  await t.test('(b) a catalogued model with no platform key is listed but flagged, not hidden', async () => {
    const body = await getJson()
    const claude = body.data.find((m: any) => m.id === 'claude-sonnet-4')
    assert.ok(claude, 'the catalogue still shows what it prices')
    assert.equal(claude.available, false)
    assert.equal(claude.byok_supported, true)
    assert.equal(claude.provider_key_var, 'PROV_ANTHROPIC_API_KEY')
  })

  await t.test('(c) auto is offered and resolves to a servable, non-mock model', async () => {
    const body = await getJson()
    const auto = body.data.find((m: any) => m.id === 'auto')
    assert.ok(auto)
    assert.equal(auto.available, true)
    assert.notEqual(auto.resolves_to, 'thirdeye-mock')
    const target = body.data.find((m: any) => m.id === auto.resolves_to)
    assert.ok(target, 'resolves_to must name a row in this same list')
    assert.equal(target.available, true)
    assert.equal(auto.resolves_to, 'auto-probe', 'the cheapest servable row wins')
  })

  await t.test('(d) the refusal names models that work instead of asking for a key', async () => {
    const res = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 402)
    const body: any = await res.json()
    assert.equal(body.error.code, 'model_unavailable')
    assert.equal(body.error.param, 'model')
    assert.equal(body.error.model, 'claude-sonnet-4')
    assert.equal(body.error.provider, 'anthropic')
    assert.equal(body.error.hint, 'retry_with_available_model')
    assert.ok(Array.isArray(body.error.available_models))
    assert.ok(body.error.available_models.includes('auto-probe'))
    assert.ok(!body.error.available_models.includes('thirdeye-mock'), 'an echo is not a substitute')
    assert.match(body.error.message, /auto-probe/, 'the message must name a model that works')
    assert.match(body.error.message, /BYOK/)
  })

  await t.test('(e) auto reaches the resolved model, not a 404 and not the mock', async () => {
    const res = await app.request('/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // The probe host is closed, so the call fails at the network. What matters is that it got
    // that far: the model was resolved before any provider work, and the header says which.
    assert.ok(res.status >= 500, `expected an upstream failure, got ${res.status}`)
    assert.equal(res.headers.get('X-Thirdeye-Model-Resolved'), 'auto-probe')
    const usage = await one('SELECT model FROM usage_events WHERE user_id = $1 ORDER BY created_at DESC', [userId])
    assert.equal(usage.model, 'auto-probe', 'the ledger records what was billed, not the alias')
  })

  await t.test('(f) every PROV_ key the platform holds is actually reflected in the catalogue', async () => {
    // The env this test runs under holds exactly one probe key. If someone adds a platform key
    // and the catalogue still reports its models unavailable, the derivation is wrong again.
    assert.ok(env.providerKeys.probe, 'the probe key must be visible to the provider loader')
    const body = await getJson()
    const probe = body.data.find((m: any) => m.id === 'auto-probe')
    assert.equal(probe.available, true)
  })
})
