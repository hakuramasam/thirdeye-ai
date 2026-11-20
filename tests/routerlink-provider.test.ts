import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveProviderName } from '../src/providers/index.js'
import { buildEndpoint } from '../src/providers/openai.js'

test('RouterLink model rows use the stable routerlink credential namespace', () => {
  const model = {
    model: 'routerlink/example-model',
    provider: 'routerlink',
    upstream_model: 'vendor/model-exact-id',
    base_url: 'https://router-link.world3.ai/api/v1',
    price_in_1m_usd_micros: 0,
    price_out_1m_usd_micros: 0,
    enabled: false,
  }
  assert.equal(deriveProviderName(model), 'routerlink')
})

test('RouterLink OpenAI-compatible base URL resolves to chat completions exactly once', () => {
  assert.equal(
    buildEndpoint('https://router-link.world3.ai/api/v1'),
    'https://router-link.world3.ai/api/v1/chat/completions'
  )
  assert.equal(
    buildEndpoint('https://router-link.world3.ai/api/v1/'),
    'https://router-link.world3.ai/api/v1/chat/completions'
  )
  assert.equal(
    buildEndpoint('https://router-link.world3.ai/api/v1/chat/completions'),
    'https://router-link.world3.ai/api/v1/chat/completions'
  )
})

test('RouterLink provider does not infer the API key name from its gateway hostname', () => {
  const model = {
    model: 'routerlink/example-model',
    provider: 'routerlink',
    upstream_model: 'vendor/model-exact-id',
    base_url: 'https://router-link.world3.ai/api/v1',
    price_in_1m_usd_micros: 0,
    price_out_1m_usd_micros: 0,
    enabled: false,
  }
  assert.notEqual(deriveProviderName(model), 'router-link')
  assert.equal(deriveProviderName(model), 'routerlink')
})
