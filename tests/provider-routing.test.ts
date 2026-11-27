import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.PGLITE_DIR = 'memory://'
const { deriveProviderName } = await import('../src/providers/index.js')

test('provider routing uses the canonical Google key name for Gemini OpenAI-compatible endpoint', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
  } as any

  assert.equal(deriveProviderName(model), 'google')
})

test('provider routing keeps existing hostname-derived keys for other OpenAI-compatible providers', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: 'https://api.mistral.ai/v1',
  } as any

  assert.equal(deriveProviderName(model), 'mistral')
})

test('provider routing falls back to catalog provider when base URL is invalid', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: '://invalid-url',
  } as any

  assert.equal(deriveProviderName(model), 'openai-compatible')
})
