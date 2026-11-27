import { test } from 'node:test'
import assert from 'node:assert/strict'

// This module imports the provider registry, which imports the DB and environment modules.
// Force the same isolated environment used by the PGlite suite before those imports run.
delete process.env.PREVIEW_DATABASE_URL
delete process.env.DATABASE_URL
delete process.env.DATABASE_URL_UNPOOLED
process.env.PGLITE_DIR = 'memory://'

const { deriveProviderName } = await import('../src/providers/index.js')

test('provider routing uses the canonical Google key name for Gemini OpenAI-compatible endpoint', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
  } as any

  assert.equal(deriveProviderName(model), 'google')
})

test('provider routing does not select Google credentials for an insecure Gemini URL', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: 'http://generativelanguage.googleapis.com/v1beta/openai',
  } as any

  assert.equal(deriveProviderName(model), 'openai-compatible')
})

test('provider routing does not select Google credentials for a nonstandard Gemini port', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: 'https://generativelanguage.googleapis.com:8443/v1beta/openai',
  } as any

  assert.equal(deriveProviderName(model), 'openai-compatible')
})

test('provider routing does not select Google credentials for a Gemini URL with embedded credentials', () => {
  const model = {
    provider: 'openai-compatible',
    base_url: 'https://attacker:secret@generativelanguage.googleapis.com/v1beta/openai',
  } as any

  assert.equal(deriveProviderName(model), 'openai-compatible')
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
