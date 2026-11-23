process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The server-rendered pages read their channel URLs from src/routes/public.ts, and the React bundle
// reads them from web/src/brand.ts. The two bundles cannot import each other, so a handle changed in one
// place would silently leave the other stale. This test is the seam.
const server = readFileSync(fileURLToPath(new URL('../src/routes/public.ts', import.meta.url)), 'utf8')
const browser = readFileSync(fileURLToPath(new URL('../web/src/brand.ts', import.meta.url)), 'utf8')
const landing = readFileSync(fileURLToPath(new URL('../web/src/pages1.tsx', import.meta.url)), 'utf8')

function constant(source: string, name: string): string {
  const m = new RegExp(`export const ${name} = '([^']+)'`).exec(source)
  assert.ok(m, `${name} must be exported as a quoted constant`)
  return m[1]
}

for (const name of ['X_URL', 'TELEGRAM_URL', 'ABUND_URL']) {
  test(`${name} is identical in the server constants and the browser bundle`, () => {
    assert.equal(constant(server, name), constant(browser, name))
  })
}

test('the landing page links through the shared constants instead of literal handles', () => {
  assert.match(landing, /from '\.\/brand'/)
  assert.doesNotMatch(landing, /href="https:\/\/(x\.com|t\.me|abund\.ai)/, 'external channel URLs must not be inlined in markup')
})

test('the contact page still publishes every channel the landing page links to', () => {
  for (const name of ['X_URL', 'TELEGRAM_URL', 'ABUND_URL']) {
    assert.ok(server.includes(`\${${name}}`), `the /contact markup must render ${name}`)
  }
})
