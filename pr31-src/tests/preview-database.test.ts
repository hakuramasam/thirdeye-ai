import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The preview database variable has to win over DATABASE_URL, because a preview-scoped
 * DATABASE_URL does not reach the preview runtime in this project. Env is read at import
 * time, so each case imports a fresh module instance.
 */
async function databaseUrlFor(preview: string | undefined, base: string | undefined): Promise<string> {
  if (preview === undefined) delete process.env.PREVIEW_DATABASE_URL
  else process.env.PREVIEW_DATABASE_URL = preview
  if (base === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = base
  const mod = await import(`../src/lib/env.ts?case=${preview ?? 'none'}_${base ?? 'none'}`)
  return mod.env.databaseUrl
}

test('PH2-003 a preview database url wins over the shared one', async () => {
  const url = await databaseUrlFor('postgresql://branch/previewdb', 'postgresql://prod/livedb')
  assert.equal(url, 'postgresql://branch/previewdb')
})

test('PH2-003 production keeps reading DATABASE_URL when no preview value is set', async () => {
  const url = await databaseUrlFor(undefined, 'postgresql://prod/livedb')
  assert.equal(url, 'postgresql://prod/livedb')
})

test('PH2-003 an absent database url still means embedded postgres', async () => {
  assert.equal(await databaseUrlFor(undefined, undefined), '')
})
