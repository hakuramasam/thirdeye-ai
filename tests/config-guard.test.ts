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
