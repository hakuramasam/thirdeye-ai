process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { Hono } = await import('hono')
const { registerPublicRoutes } = await import('../src/routes/public.js')
const { migrate } = await import('../src/db/index.js')
const { CHANGELOG, SUITE } = await import('../src/data/changelog.js')

function app() {
  const a = new Hono()
  registerPublicRoutes(a as any)
  return a
}

const PATHS = ['/platform', '/docs', '/docs/api', '/docs/mcp', '/docs/x402', '/docs/agents', '/roadmap', '/partnerships', '/changelog', '/agents', '/team', '/whitepaper']

/**
 * The whitepaper cites a public transaction hash so a reader can decode the launch themselves. That
 * hash is 64 hex characters, exactly the shape the key scan below hunts for, so it is removed from
 * the body before the scan rather than the scan being weakened for every other page.
 */
const PUBLIC_HASHES = ['0x66e65f6e49bf08a34cbc703df9ae6b2d4fd983a2a2068340a17a53b93589ead2']

test('every public page renders as html with a title', async () => {
  await migrate()
  const a = app()
  for (const path of PATHS) {
    const res = await a.request(path)
    assert.equal(res.status, 200, `${path} should be 200`)
    assert.match(res.headers.get('content-type') || '', /text\/html/, `${path} should be html`)
    const body = await res.text()
    assert.match(body, /<title>[^<]+ · Thirdeye AI<\/title>/, `${path} should carry a page title`)
    assert.match(body, /<nav>/, `${path} should carry the navigation`)
  }
})

test('the status page reports liveness and the suite size without inventing numbers', async () => {
  await migrate()
  const res = await app().request('/status')
  const body = await res.text()
  assert.equal(res.status, 200)
  assert.match(body, /database (up|down|unknown)/)
  assert.ok(body.includes(String(SUITE.tests)), 'suite size should appear')
  assert.ok(body.includes(SUITE.measuredOn), 'suite measurement date should appear')
})

test('the changelog renders real commits and excludes nothing it claims to show', async () => {
  await migrate()
  const body = await (await app().request('/changelog')).text()
  assert.ok(CHANGELOG.length >= 5, 'there should be real history to show')
  for (const entry of CHANGELOG.slice(0, 5)) {
    assert.ok(body.includes(entry.sha), `commit ${entry.sha} should be listed`)
  }
})

test('no public page leaks a credential, a secret name or a private key', async () => {
  await migrate()
  const a = app()
  for (const path of [...PATHS, '/status']) {
    const body = await (await a.request(path)).text()
    for (const forbidden of ['sk-thirdeye', 'MASTER_KEY', 'DATABASE_URL=', 'PRIVY', 'private_key']) {
      assert.ok(!body.includes(forbidden), `${path} leaked ${forbidden}`)
    }
    const scrubbed = PUBLIC_HASHES.reduce((acc, h) => acc.split(h).join(''), body)
    assert.ok(!/[0-9a-f]{64}/i.test(scrubbed), `${path} contains something shaped like a raw key`)
  }
})

test('the whitepaper cites the onchain record rather than asserting a sale', async () => {
  await migrate()
  const body = await (await app().request('/whitepaper')).text()
  assert.ok(body.includes('0xA8A65A86E01D227Dbfd7C7a94d14344b33603df5'), 'the token contract should be named')
  assert.ok(body.includes(PUBLIC_HASHES[0]), 'the launch transaction should be citable')
  assert.ok(body.includes('1,000,000,000'), 'the fixed supply should be stated')
  assert.match(body, /No token was sold/, 'the absence of a sale has to be explicit')
  assert.match(body, /not an offer to sell/, 'the document must disclaim being an offer')
  for (const claim of ['x-thirdeye-cost-usd', '/api/v1/models', '/status', '/changelog']) {
    assert.ok(body.includes(claim), `the whitepaper should point at ${claim} as verification`)
  }
})

test('the docs name the real endpoints rather than a generic promise', async () => {
  await migrate()
  const body = await (await app().request('/docs/api')).text()
  for (const endpoint of ['/api/v1/chat/completions', '/api/v1/models', '/api/keys', '/api/feedback']) {
    assert.ok(body.includes(endpoint), `docs should document ${endpoint}`)
  }
  assert.ok(body.includes('x-thirdeye-cost-usd'), 'docs should name the billing header')
})

test('the partnership page states terms are private and names only disclosed partners', async () => {
  await migrate()
  const body = await (await app().request('/partnerships')).text()
  assert.match(body, /never its terms/i)
  assert.ok(body.includes('Coin Gawd'), 'the disclosed partner should be listed')
})

test('the agent directory page renders an empty state rather than an error when nothing is registered', async () => {
  await migrate()
  const body = await (await app().request('/agents')).text()
  assert.match(body, /Agent directory/)
  assert.match(body, /No agents registered yet|homepage/)
})

test('the agent docs state the billing basis instead of implying an agent can fund itself', async () => {
  await migrate()
  const body = await (await app().request('/docs/agents')).text()
  assert.match(body, /cannot hold its own balance/i)
  assert.ok(body.includes('/api/v1/agents/directory'))
})

test('an unknown path is not handled by the public module', async () => {
  await migrate()
  const res = await app().request('/nope-not-a-page')
  assert.equal(res.status, 404)
})

// ── brand surface ───────────────────────────────────────────────────────────
// The head, the icon set and the social card are one contract: a link that points at a
// file we never shipped is the same defect as a favicon that is the wrong size, and both
// are invisible until someone else's timeline renders them.
const { readFileSync, existsSync } = await import('node:fs')
const { join } = await import('node:path')
const PUBLIC = join(process.cwd(), 'web/public')

/** Minimal PNG reader: width, height, bit depth and colour type straight from IHDR. */
function png(path: string) {
  const b = readFileSync(join(PUBLIC, path))
  assert.equal(b.subarray(1, 4).toString(), 'PNG', `${path} should be a PNG`)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], colorType: b[25] }
}

test('every public page carries a complete, real social and icon head', async () => {
  await migrate()
  const a = app()
  for (const path of PATHS) {
    const body = await (await a.request(path)).text()
    assert.ok(body.includes('content="summary_large_image"'), `${path} should declare a large social card`)
    assert.ok(body.includes('https://thirdeye-ai-alpha.vercel.app/og.png'), `${path} should point og:image at the shipped card`)
    assert.ok(body.includes('rel="icon"'), `${path} should link a favicon`)
    assert.ok(body.includes('rel="manifest"'), `${path} should link the web manifest`)
    assert.ok(body.includes(`<link rel="canonical" href="https://thirdeye-ai-alpha.vercel.app${path}">`), `${path} should be self-canonical`)
    // every root-relative asset the head references must exist on disk
    for (const [, href] of body.matchAll(/(?:href|src|content)="\/([^"]+\.(?:png|ico|svg|webmanifest))"/g)) {
      assert.ok(existsSync(join(PUBLIC, href)), `${path} references /${href}, which is not in web/public`)
    }
  }
})

test('the icon set matches the sizes the platforms actually ask for', () => {
  assert.deepEqual([png('favicon-16x16.png').w, png('favicon-16x16.png').h], [16, 16])
  assert.deepEqual([png('favicon-32x32.png').w, png('favicon-32x32.png').h], [32, 32])
  assert.deepEqual([png('apple-touch-icon.png').w, png('apple-touch-icon.png').h], [180, 180])
  assert.deepEqual([png('icon-192.png').w, png('icon-192.png').h], [192, 192])
  assert.deepEqual([png('icon-512.png').w, png('icon-512.png').h], [512, 512])
  assert.deepEqual([png('icon-maskable-512.png').w, png('icon-maskable-512.png').h], [512, 512])
  // iOS composites a transparent apple-touch-icon onto black, and DEXes reject alpha outright
  assert.equal(png('apple-touch-icon.png').colorType, 2, 'apple-touch-icon must be opaque')
  assert.equal(png('brand/token-avatar-512.png').colorType, 2, 'token avatar must be opaque')
  assert.deepEqual([png('brand/token-avatar-512.png').w, png('brand/token-avatar-512.png').h], [512, 512])
  assert.ok(existsSync(join(PUBLIC, 'favicon.ico')), 'favicon.ico should exist for legacy clients')
  assert.equal(readFileSync(join(PUBLIC, 'favicon.ico')).readUInt16LE(2), 1, 'favicon.ico should be an icon file')
})

test('the banner and card assets are the exact dimensions their destinations crop to', () => {
  const og = png('brand/og-1200x630.png')
  assert.deepEqual([og.w, og.h], [1200, 630], 'og card is 1200x630')
  const xb = png('brand/x-banner-1500x500.png')
  assert.deepEqual([xb.w, xb.h], [1500, 500], 'X banner is 1500x500')
  const gh = png('brand/github-social-1280x640.png')
  assert.deepEqual([gh.w, gh.h], [1280, 640], 'GitHub social preview is 1280x640')
  // the shipped card and its source must not drift apart
  assert.equal(readFileSync(join(PUBLIC, 'og.png')).length, readFileSync(join(PUBLIC, 'brand/og-1200x630.png')).length,
    'og.png should be the brand card, byte for byte')
})

test('the manifest declares installable icons and the ink theme', async () => {
  const m = JSON.parse(readFileSync(join(PUBLIC, 'site.webmanifest'), 'utf8'))
  assert.equal(m.theme_color, '#0A0C10')
  assert.equal(m.background_color, '#0A0C10')
  assert.ok(m.icons.some((i: any) => i.purpose === 'maskable'), 'there should be a maskable icon')
  for (const i of m.icons) {
    assert.ok(existsSync(join(PUBLIC, i.src.replace(/^\//, ''))), `manifest icon ${i.src} should exist`)
  }
})

// ── team activity ───────────────────────────────────────────────────────────
// This page is the one public surface that reads operational rows, so the tests are about
// boundaries rather than layout: what it selects, and what it must never let through.

const { query } = await import('../src/db/index.js')

async function seedTeam() {
  await migrate()
  await query(`INSERT INTO users (id, wallet, role) VALUES ('u_team', '0x5555555555555555555555555555555555555555', 'user') ON CONFLICT DO NOTHING`)
  await query(
    `INSERT INTO agents (id, user_id, name, system_prompt, model, budget_usd_micros, max_steps)
     VALUES ('tdt_hermes_test', 'u_team', 'HERMES', 'SECRET-PROMPT-TEXT', 'ministral-14b', 12000, 6)
     ON CONFLICT (id) DO UPDATE SET name = 'HERMES'`
  )
  await query(
    `INSERT INTO agent_runs (id, agent_id, user_id, status, input, output, tool_calls, spend_usd_micros, error)
     VALUES ('run_ok', 'tdt_hermes_test', 'u_team', 'success', 'SECRET-INPUT-TEXT', 'SECRET-OUTPUT-TEXT', 2, 458, NULL),
            ('run_rl', 'tdt_hermes_test', 'u_team', 'error', 'SECRET-INPUT-TEXT', NULL, 0, 0,
             'uncaught: Rate limit reached for model openai/gpt-oss-120b in organization org-SECRETORG')
     ON CONFLICT (id) DO NOTHING`
  )
  await query(
    `INSERT INTO agent_run_events (id, run_id, agent_id, seq, tool, ok, refused, args_excerpt, result_excerpt)
     VALUES ('ev_ok', 'run_ok', 'tdt_hermes_test', 1, 'repo_read', true, false, 'SECRET-ARGS-EXCERPT', 'SECRET-RESULT-EXCERPT'),
            ('ev_no', 'run_ok', 'tdt_hermes_test', 2, 'delegate_to_agent', false, true, 'SECRET-ARGS-EXCERPT', NULL)
     ON CONFLICT (id) DO NOTHING`
  )
  await query(
    `INSERT INTO agent_alerts (id, code, severity, agent_id, run_id, summary, evidence, dedupe_key)
     VALUES ('al_test', 'failed_run', 'medium', 'tdt_hermes_test', 'run_rl', 'SECRET-SUMMARY-TEXT', '{"SECRET":"EVIDENCE"}', 'dedupe-test-team')
     ON CONFLICT (dedupe_key) DO NOTHING`
  )
}

test('the team page reports the recorded rows instead of a hand-written summary', async () => {
  await seedTeam()
  const body = await (await app().request('/team')).text()
  assert.match(body, /Agent team activity/)
  assert.ok(body.includes('HERMES'), 'the agent name should come from the ledger')
  assert.ok(body.includes('repo_read'), 'tool names should be listed')
  assert.ok(body.includes('delegate_to_agent'), 'a delegation should be listed')
  assert.match(body, /Runs recorded/)
  assert.ok(body.includes('failed_run'), 'open findings should be listed')
})

test('the team page reduces a provider error to a reason code and never prints the raw text', async () => {
  await seedTeam()
  const body = await (await app().request('/team')).text()
  assert.match(body, /provider rate limit/, 'the failure should be classified')
  assert.ok(!body.includes('SECRETORG'), 'the provider organisation must not be published')
  assert.ok(!body.includes('gpt-oss-120b in organization'), 'raw provider text must not be published')
  assert.ok(!body.includes('uncaught'), 'the raw error wrapper must not be published')
})

test('the team page never renders prompts, arguments, results, outputs or alert evidence', async () => {
  await seedTeam()
  const body = await (await app().request('/team')).text()
  for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-INPUT-TEXT', 'SECRET-OUTPUT-TEXT', 'SECRET-ARGS-EXCERPT', 'SECRET-RESULT-EXCERPT', 'SECRET-SUMMARY-TEXT', 'SECRET-WRONG']) {
    assert.ok(!body.includes(secret), `the team page leaked ${secret}`)
  }
  assert.ok(!body.includes('EVIDENCE'), 'alert evidence jsonb must not be rendered')
})

test('a run left marked running long after it started is published as stuck, not as running', async () => {
  const { runPill, STUCK_AFTER_MS } = await import('../src/routes/public.js')
  const old = new Date(Date.now() - STUCK_AFTER_MS - 60_000)
  assert.match(runPill('running', old, null), /stuck/)
  assert.match(runPill('running', new Date(), null), /running/)
  assert.match(runPill('success', old, null), /ok/)
})

test('the team page shows an empty state, not an error, when the team has never run', async () => {
  await migrate()
  await query(`DELETE FROM agent_run_events`).catch(() => {})
  await query(`DELETE FROM agent_runs`).catch(() => {})
  await query(`DELETE FROM agent_alerts WHERE dedupe_key LIKE 'dedupe-test%'`)
  const body = await (await app().request('/team')).text()
  assert.match(body, /No runs recorded yet|No tool calls logged yet/)
  assert.match(body, /No findings raised/)
})

test('a failing ledger query renders a stated failure rather than an empty table', async () => {
  await migrate()
  await query(`ALTER TABLE agent_run_events RENAME TO agent_run_events_hidden`)
  try {
    const body = await (await app().request('/team')).text()
    assert.match(body, /The ledger did not answer/)
    assert.ok(!body.includes('No runs recorded'), 'a broken query must not read as a quiet team')
  } finally {
    await query(`ALTER TABLE agent_run_events_hidden RENAME TO agent_run_events`)
  }
})
