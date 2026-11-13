import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'

import {
  configGuard,
  configStatus,
  healthzBody,
  misconfiguredBody,
  HEALTH_PATH,
} from '../src/lib/config-guard.js'
import { validateSecrets, DEV_SECRET_VALUES } from '../src/lib/security.js'

const PROBLEMS = [
  { name: 'SESSION_SECRET', problem: 'missing or a known development value' },
  { name: 'MASTER_KEY', problem: 'shorter than 32 characters' },
]

/** A tiny app carrying the guard, so the assertions are about behaviour and not internals. */
function guarded(problems: { name: string; problem: string }[]) {
  const app = new Hono()
  app.use('*', configGuard(problems) as never)
  app.get(HEALTH_PATH, (c) => c.json(healthzBody(problems, 'postgres', '2026-11-11T00:00:00.000Z')))
  app.get('/api/v1/models', (c) => c.json({ data: [] }))
  app.post('/api/credits/redeem/quote', (c) => c.json({ quoted: true }))
  return app
}

test('a clean configuration serves normally and reports ok', async () => {
  assert.deepEqual(configStatus([]), { ok: true, problems: [] })
  const res = await guarded([]).request('/api/v1/models')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { data: [] })

  const health = await guarded([]).request(HEALTH_PATH)
  assert.equal(health.status, 200)
  const body = (await health.json()) as any
  assert.equal(body.ok, true)
  assert.equal(body.config.ok, true)
  assert.deepEqual(body.config.problems, [])
})

test('an unsafe configuration refuses every API route with 503 and the reason', async () => {
  for (const path of ['/api/v1/models', '/api/credits/redeem/quote']) {
    const res = await guarded(PROBLEMS).request(path, { method: path.includes('redeem') ? 'POST' : 'GET' })
    assert.equal(res.status, 503, path)
    const body = (await res.json()) as any
    assert.equal(body.error.type, 'misconfigured')
    assert.equal(body.error.problems.length, 2)
    assert.deepEqual(
      body.error.problems.map((p: any) => p.name),
      ['SESSION_SECRET', 'MASTER_KEY']
    )
    assert.match(body.error.problems[0].problem, /development value/)
  }
})

test('the refusal never carries a secret value, only a name', async () => {
  const secret = 'a'.repeat(64)
  const body = JSON.stringify(misconfiguredBody([{ name: 'MASTER_KEY', problem: 'missing' }]))
  assert.ok(body.includes('MASTER_KEY'))
  assert.ok(!body.includes(secret))
  // The shape itself is closed: only name and problem survive into the response.
  const payload = JSON.parse(body)
  assert.deepEqual(Object.keys(payload.error.problems[0]).sort(), ['name', 'problem'])
})

test('health stays reachable while misconfigured, and fails on its body not on its code', async () => {
  const res = await guarded(PROBLEMS).request(HEALTH_PATH)
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.equal(body.ok, false)
  assert.equal(body.mode, 'postgres')
  assert.equal(body.config.ok, false)
  assert.deepEqual(body.config.problems.map((p: any) => p.name), ['SESSION_SECRET', 'MASTER_KEY'])
  assert.equal(body.time, '2026-11-11T00:00:00.000Z')
})

test('the health payload is deterministic, so a monitor can diff it', () => {
  const a = healthzBody([], 'postgres', '2026-11-11T00:00:00.000Z')
  const b = healthzBody([], 'postgres', '2026-11-11T00:00:00.000Z')
  assert.deepEqual(a, b)
})

test('the underlying refusal is unchanged: production still rejects dev and short secrets', () => {
  for (const bad of ['thirdeye-dev-session-secret', 'thirdeye-dev-master-key', 'short', '']) {
    assert.ok(DEV_SECRET_VALUES.has(bad) || bad.length < 32, bad)
    const problems = validateSecrets({ sessionSecret: bad, masterKey: 'x'.repeat(64), nodeEnv: 'production' })
    assert.equal(problems.length, 1, bad)
    assert.equal(problems[0].name, 'SESSION_SECRET')
  }
  // Identical secrets are refused too, and development stays usable so local work is not blocked.
  const same = 'y'.repeat(64)
  assert.equal(validateSecrets({ sessionSecret: same, masterKey: same, nodeEnv: 'production' }).length, 1)
  assert.deepEqual(validateSecrets({ sessionSecret: 'short', masterKey: 'short', nodeEnv: 'development' }), [])
})

// ── A deployed runtime with no database ────────────────────────────────────────────────────────

import { validateDatabase } from '../src/lib/security.js'

test('a serverless boot with no connection string is refused, not silently run in memory', () => {
  const problems = validateDatabase({ databaseUrl: '', isServerless: true })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].name, 'DATABASE_URL')
  assert.match(problems[0].problem, /in-memory/)
  assert.equal(problems[0].problem.includes('memory://'), false, 'name the consequence, not the URL')
})

test('a production boot without a connection string is refused even off serverless', () => {
  assert.equal(validateDatabase({ databaseUrl: '', nodeEnv: 'production' }).length, 1)
  // Local work and the test suite run the file-backed database on purpose.
  assert.deepEqual(validateDatabase({ databaseUrl: '', nodeEnv: 'development' }), [])
  assert.deepEqual(validateDatabase({ databaseUrl: '', isServerless: false }), [])
})

test('a real connection string passes, and a wrong scheme does not', () => {
  assert.deepEqual(validateDatabase({ databaseUrl: 'postgresql://u:p@host/db', isServerless: true }), [])
  assert.deepEqual(validateDatabase({ databaseUrl: '  postgres://u:p@host/db  ', isServerless: true }), [])
  const wrong = validateDatabase({ databaseUrl: 'mysql://u:p@host/db', isServerless: true })
  assert.equal(wrong.length, 1)
  assert.match(wrong[0].problem, /postgres/)
})

test('the database refusal behaves like a secret refusal: 503 everywhere, health still answers', async () => {
  const problems = validateDatabase({ databaseUrl: '', isServerless: true })
  const app = guarded(problems)

  const api = await app.request('/api/v1/models')
  assert.equal(api.status, 503)
  const body = (await api.json()) as any
  assert.equal(body.error.type, 'misconfigured')
  assert.deepEqual(
    body.error.problems.map((p: any) => p.name),
    ['DATABASE_URL']
  )

  // The health endpoint stays reachable, so the refusal is observable from outside.
  const healthApp = new Hono()
  healthApp.use('*', configGuard(problems) as never)
  healthApp.get(HEALTH_PATH, (c) => c.json(healthzBody(problems, 'pglite', '2026-11-11T00:00:00.000Z')))
  const health = await healthApp.request(HEALTH_PATH)
  assert.equal(health.status, 200)
  const hb = (await health.json()) as any
  assert.equal(hb.ok, false, 'a monitor fails on the body, not just on the status code')
  assert.equal(hb.mode, 'pglite', 'the mode shows the in-memory fallback that caused the refusal')
  assert.equal(hb.config.problems[0].name, 'DATABASE_URL')
})

test('the refusal names the variable a preview actually reads, not the conventional one', () => {
  // Previews prefer PREVIEW_DATABASE_URL, so an operator told to fix DATABASE_URL would be editing
  // a variable the runtime never consulted.
  const preview = validateDatabase({ databaseUrl: '', databaseUrlVar: 'PREVIEW_DATABASE_URL', isServerless: true })
  assert.deepEqual(preview.map((p) => p.name), ['PREVIEW_DATABASE_URL'])
  const prod = validateDatabase({ databaseUrl: '', databaseUrlVar: 'DATABASE_URL', isServerless: true })
  assert.deepEqual(prod.map((p) => p.name), ['DATABASE_URL'])
})

test('the missing-database reason states the fallback that would run, not just one of its forms', () => {
  const [problem] = validateDatabase({ databaseUrl: '', isServerless: true })
  // In-memory is the serverless form; a file-backed local boot is the other. Name the fallback.
  assert.match(problem.problem, /local database/)
  assert.match(problem.problem, /in-memory one on serverless/)
  assert.equal(problem.problem.includes('memory://'), false, 'name the consequence, not the URL')
})

test('a deployment with a malformed DATABASE_URL still answers health, naming the reason', async () => {
  const { spawnSync } = await import('node:child_process')
  const probe = spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/app-health-probe.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: 'mysql://u:p@example.invalid/db',
      PREVIEW_DATABASE_URL: '',
      NODE_ENV: 'production',
      VERCEL: '1',
      PGLITE_DIR: 'memory://',
      SESSION_SECRET: 's'.repeat(64),
      MASTER_KEY: 'm'.repeat(64),
    },
    encoding: 'utf8',
    timeout: 180_000,
  })
  const line = String(probe.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'
  const out = JSON.parse(line) as Record<string, { status: number; body: any }>

  // The whole point: migrate() would throw on this URL, and health has to survive it.
  assert.equal(out['/api/healthz'].status, 200, `health should answer, got ${JSON.stringify(out)}`)
  assert.equal(out['/api/healthz'].body.ok, false)
  assert.deepEqual(
    out['/api/healthz'].body.config.problems.map((p: any) => p.name),
    ['DATABASE_URL']
  )
  assert.match(out['/api/healthz'].body.config.problems[0].problem, /postgres/)

  // Everything else is refused, so the bad configuration is never served traffic.
  assert.equal(out['/api/v1/models'].status, 503)
  assert.equal(out['/api/v1/models'].body.error.type, 'misconfigured')
})

// ── Readiness measures the database; liveness does not ─────────────────────────────────────────

import { livezBody, LIVE_PATH } from '../src/lib/config-guard.js'
import { probe } from '../src/db/index.js'

test('readiness fails when the database it measured is unreachable', () => {
  const healthy = healthzBody([], 'postgres', '2026-11-11T00:00:00.000Z', { ok: true, ms: 3 })
  assert.equal(healthy.ok, true)
  assert.deepEqual(healthy.database, { ok: true, ms: 3 })

  const down = healthzBody([], 'postgres', '2026-11-11T00:00:00.000Z', { ok: false, ms: 2000, error: 'timeout' })
  assert.equal(down.ok, false, 'a reachable configuration over a dead database is not ready')
  assert.equal(down.database!.ok, false)
  assert.equal(down.database!.error, 'timeout')
})

test('a health body that measured nothing claims nothing', () => {
  // Before, `ok` meant only "the secrets are fine" while the body called itself health.
  const unmeasured = healthzBody([], 'pglite', '2026-11-11T00:00:00.000Z')
  assert.equal(unmeasured.database, null)
  assert.equal(JSON.stringify(unmeasured).includes('"database":{"ok":true'), false, 'no invented database result')
})

test('liveness stays true through a database outage and a refused configuration', async () => {
  const problems = validateDatabase({ databaseUrl: '', isServerless: true })
  const app = new Hono()
  app.use('*', configGuard(problems) as never)
  app.get(LIVE_PATH, (c) => c.json(livezBody('pglite', '2026-11-11T00:00:00.000Z')))

  const res = await app.request(LIVE_PATH)
  assert.equal(res.status, 200, 'a probe the guard blocks cannot report the reason it is blocked')
  const body = (await res.json()) as any
  assert.deepEqual(body, { ok: true, mode: 'pglite', time: '2026-11-11T00:00:00.000Z' })
})

test('the probe answers against a live database and is bounded when there is none', async () => {
  const { spawnSync } = await import('node:child_process')

  // The suite runs DATABASE_URL unset, so this exercises the local PGlite driver. It runs in a
  // child because src/db/index.ts reads its directory from process.env at import time.
  const live = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `import('./src/db/index.ts').then(async (m) => {
         const p = await m.probe(2000)
         console.log(JSON.stringify(p))
       })`,
    ],
    {
      env: { ...process.env, DATABASE_URL: '', PREVIEW_DATABASE_URL: '', PGLITE_DIR: 'memory://' },
      encoding: 'utf8',
      timeout: 60_000,
    }
  )
  const liveLine = String(live.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'
  const alive = JSON.parse(liveLine) as { ok: boolean; ms: number }
  assert.equal(alive.ok, true, `probe should succeed on PGlite: ${live.stdout}${live.stderr}`)
  assert.equal(typeof alive.ms, 'number')

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `import('./src/db/index.ts').then(async (m) => {
         const t = Date.now()
         const p = await m.probe(1200)
         console.log(JSON.stringify({ ...p, elapsed: Date.now() - t }))
       })`,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://probeuser:probesecret@127.0.0.1:1/probedb',
        PREVIEW_DATABASE_URL: '',
        PGLITE_DIR: 'memory://',
      },
      encoding: 'utf8',
      timeout: 60_000,
    }
  )
  const line = String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'
  const down = JSON.parse(line) as { ok: boolean; error?: string; elapsed: number; ms: number }
  assert.equal(down.ok, false)
  assert.ok(['unreachable', 'timeout', 'error'].includes(String(down.error)), `got ${JSON.stringify(down)}`)
  assert.ok(down.elapsed < 10_000, `the probe must not hang: ${down.elapsed}ms`)
  assert.equal(JSON.stringify(down).includes('probesecret'), false, 'the probe never echoes credentials')
})

test('a deployment whose database refuses connections reports not-ready, without leaking it', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/app-health-probe.ts'], {
    env: {
      ...process.env,
      PROBE_PATHS: '/api/livez,/api/healthz,/api/v1/models',
      DATABASE_URL: 'postgres://probeuser:probesecret@127.0.0.1:1/probedb',
      PREVIEW_DATABASE_URL: '',
      NODE_ENV: 'production',
      VERCEL: '1',
      PGLITE_DIR: 'memory://',
      SESSION_SECRET: 's'.repeat(64),
      MASTER_KEY: 'm'.repeat(64),
      HEALTH_DB_TIMEOUT_MS: '1500',
    },
    encoding: 'utf8',
    timeout: 180_000,
  })
  const line = String(result.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'
  const out = JSON.parse(line) as Record<string, { status: number; body: any }>

  const live = out['/api/livez']
  assert.equal(live.status, 200)
  assert.equal(live.body.ok, true, 'the process is up even when its database is not')

  const ready = out['/api/healthz']
  assert.equal(ready.status, 200, 'the body carries the verdict, as the rest of this file assumes')
  assert.equal(ready.body.ok, false, 'a database that refuses connections is not ready')
  assert.equal(ready.body.config.ok, true, 'the configuration itself is valid; the database is the fault')
  assert.equal(ready.body.database.ok, false)
  assert.ok(['unreachable', 'error', 'timeout'].includes(ready.body.database.error))

  const text = JSON.stringify(out)
  assert.equal(text.includes('probesecret'), false, 'no credential in any probe body')
  assert.equal(text.includes('127.0.0.1'), false, 'no host in any probe body')

  // A request that needs the database still fails loudly rather than serving an empty one.
  assert.notEqual(out['/api/v1/models'].status, 200)
})
