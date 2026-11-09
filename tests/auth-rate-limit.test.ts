process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import test from 'node:test'
import assert from 'node:assert/strict'

const { checkBucketLimit } = await import('../src/lib/ratelimit.js')
const { clientBucket, AUTH_NONCE_RPM, AUTH_VERIFY_RPM, FEEDBACK_RPM, pruneExpiredNonces } = await import('../src/routes/auth.js')
const { migrate, query } = await import('../src/db/index.js')

const fakeCtx = (ip: string) => ({ req: { header: (h: string) => (h === 'x-forwarded-for' ? ip : undefined) } })

test('a bucket admits exactly its limit and then refuses', async () => {
  await migrate()
  const results: any[] = []
  for (let i = 0; i < 5; i++) results.push(await checkBucketLimit('test:bucket:a', 3))
  // Calls 1..3 are inside the budget, calls 4 and 5 are refused.
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, false])
  assert.equal(results[4].used, 5)
  assert.equal(results[4].limit, 3)
})

test('buckets are independent, so one noisy client cannot lock out another', async () => {
  await migrate()
  for (let i = 0; i < 4; i++) await checkBucketLimit('test:bucket:b', 2)
  const other = await checkBucketLimit('test:bucket:c', 2)
  assert.equal(other.ok, true)
  assert.equal(other.used, 1)
})

test('the client bucket never contains the raw IP', () => {
  const bucket = clientBucket('verify', fakeCtx('203.0.113.77'))
  assert.ok(!bucket.includes('203.0.113.77'), 'raw IP leaked into the bucket key')
  assert.match(bucket, /^auth:verify:[0-9a-f]{24}$/)
})

test('the same IP maps to the same bucket and different IPs to different ones', () => {
  assert.equal(clientBucket('nonce', fakeCtx('198.51.100.9')), clientBucket('nonce', fakeCtx('198.51.100.9')))
  assert.notEqual(clientBucket('nonce', fakeCtx('198.51.100.9')), clientBucket('nonce', fakeCtx('198.51.100.10')))
  // The nonce and verify buckets must not share a counter, or signing in would spend nonce budget.
  assert.notEqual(clientBucket('nonce', fakeCtx('198.51.100.9')), clientBucket('verify', fakeCtx('198.51.100.9')))
})

test('the first entry of x-forwarded-for is used, not the whole chain', () => {
  const bucket = clientBucket('verify', fakeCtx('198.51.100.9, 10.0.0.1, 10.0.0.2'))
  assert.equal(bucket, clientBucket('verify', fakeCtx('198.51.100.9')))
})

test('an absent client identity still produces a usable bucket', () => {
  const bucket = clientBucket('verify', { req: { header: () => undefined } })
  assert.match(bucket, /^auth:verify:[0-9a-f]{24}$/)
})

test('the limits are ordered sensibly: intake is stricter than sign-in', () => {
  assert.ok(FEEDBACK_RPM < AUTH_NONCE_RPM)
  assert.ok(AUTH_VERIFY_RPM < AUTH_NONCE_RPM, 'verify should be tighter than nonce, since it is the expensive one')
})

test('pruning removes nonces past their usable age and keeps fresh ones', async () => {
  await migrate()
  await query(`INSERT INTO auth_nonces (nonce, created_at) VALUES ($1, now() - interval '40 minutes')`, ['stale_nonce_1'])
  await query(`INSERT INTO auth_nonces (nonce, created_at) VALUES ($1, now() - interval '2 minutes')`, ['fresh_nonce_1'])
  await pruneExpiredNonces()
  const rows = await query(`SELECT nonce FROM auth_nonces WHERE nonce IN ($1,$2)`, ['stale_nonce_1', 'fresh_nonce_1'])
  const names = rows.rows.map((r: any) => r.nonce)
  assert.ok(!names.includes('stale_nonce_1'), 'a 40-minute-old nonce should be gone')
  assert.ok(names.includes('fresh_nonce_1'), 'a 2-minute-old nonce must survive')
})
