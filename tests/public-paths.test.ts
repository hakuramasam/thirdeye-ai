import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The platform serves its secondary surfaces as PATHS on one origin rather than as subdomains.
 * Subdomains were abandoned because Vercel demands a TXT at _vercel.fs.kg, a parent zone PFS
 * controls, so app/api/docs/status/blog could never verify. This pins the path contract so a
 * future edit cannot quietly drop a surface that the docs and the agent card point at.
 */
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))

test('every secondary surface is reachable as a path', () => {
  const sources = new Set<string>([
    ...(vercel.rewrites ?? []).map((r: { source: string }) => r.source),
    ...(vercel.redirects ?? []).map((r: { source: string }) => r.source),
  ])
  for (const surface of ['/api/(.*)', '/docs', '/status', '/blog', '/blog/(.*)']) {
    assert.ok(sources.has(surface), `${surface} must be routed; it is a documented surface`)
  }
})

test('the dashboard answers on /app and forwards deep links to the root app', () => {
  const redirects = (vercel.redirects ?? []) as Array<{ source: string; destination: string }>
  const bare = redirects.find((r) => r.source === '/app')
  const deep = redirects.find((r) => r.source === '/app/:path*')
  assert.ok(bare, '/app must resolve to the dashboard')
  assert.equal(bare?.destination, '/')
  assert.ok(deep, 'deep links under /app must not fall through to the SPA catch-all')
  assert.equal(deep?.destination, '/:path*')
})

test('the catch-all still serves the app shell last', () => {
  const rewrites = (vercel.rewrites ?? []) as Array<{ source: string; destination: string }>
  assert.equal(rewrites.at(-1)?.source, '/(.*)')
  assert.equal(rewrites.at(-1)?.destination, '/index.html')
})
