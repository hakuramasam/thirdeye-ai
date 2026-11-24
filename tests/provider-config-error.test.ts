process.env.PGLITE_MODE = '1'
process.env.PGLITE_DIR = 'memory://'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { env } from '../src/lib/env.js'
import { resolveProvider, UpstreamError } from '../src/providers/index.js'

const { migrate } = await import('../src/db/index.js')

before(async () => { await migrate() })

test('missing platform provider credentials are configuration errors, not payment errors', async () => {
  const previous = env.providerKeys.openai
  env.providerKeys.openai = ''
  try {
    await assert.rejects(
      () => resolveProvider(
        { id: 'provider-config-' + randomUUID() } as any,
        {
          model: 'gpt-4o',
          provider: 'openai',
          upstream_model: 'gpt-4o',
          base_url: null,
        } as any
      ),
      (error: any) => {
        assert.ok(error instanceof UpstreamError)
        assert.equal(error.status, 503)
        assert.equal(error.payload?.error?.type, 'configuration')
        assert.equal(error.payload?.error?.code, 503)
        return true
      }
    )
  } finally {
    env.providerKeys.openai = previous
  }
})
