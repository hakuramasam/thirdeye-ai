process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import test from 'node:test'
import assert from 'node:assert/strict'

const { validateFeedback } = await import('../src/routes/feedback.js')
const { query } = await import('../src/db/index.js')
const { migrate } = await import('../src/db/index.js')

const GOOD = { kind: 'bug', title: 'Deposit credited twice', body: 'Sent 1 USDC on Base, balance went up by 2 dollars.', page: '/credits', severity: 'high' }

test('a well-formed report is normalised, not rejected', () => {
  const out = validateFeedback(GOOD)
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.equal(out.value.kind, 'bug')
  assert.equal(out.value.severity, 'high')
  assert.equal(out.value.page, '/credits')
  assert.equal(out.value.contact, null)
})

test('kind and severity are constrained to known values', () => {
  const bad = validateFeedback({ ...GOOD, kind: 'complaint' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.code, 'invalid_kind')
  const badSev = validateFeedback({ ...GOOD, severity: 'urgent' })
  assert.equal(badSev.ok, false)
  if (!badSev.ok) assert.equal(badSev.code, 'invalid_severity')
})

test('the title and body have real bounds', () => {
  assert.equal(validateFeedback({ ...GOOD, title: 'fix' }).ok, false)
  assert.equal(validateFeedback({ ...GOOD, title: 'x'.repeat(161) }).ok, false)
  assert.equal(validateFeedback({ ...GOOD, body: 'short' }).ok, false)
  assert.equal(validateFeedback({ ...GOOD, body: 'y'.repeat(4001) }).ok, false)
})

test('long page and contact values are truncated rather than rejected', () => {
  const out = validateFeedback({ ...GOOD, page: '/' + 'a'.repeat(500), contact: 'e'.repeat(500) })
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.equal(out.value.page!.length, 200)
  assert.equal(out.value.contact!.length, 320)
})

test('missing optional fields become null rather than the string "undefined"', () => {
  const out = validateFeedback({ kind: 'idea', title: 'Add a status page', body: 'It would help trust a lot.' })
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.equal(out.value.page, null)
  assert.equal(out.value.contact, null)
  assert.equal(out.value.severity, 'normal')
})

test('a stored report round-trips through the table with its status intact', async () => {
  await migrate()
  await query(
    `INSERT INTO feedback (id, user_id, kind, title, body, page, contact, severity, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new')`,
    ['fb_test_1', null, 'bug', GOOD.title, GOOD.body, GOOD.page, null, 'high']
  )
  const row = await query(`SELECT title, status, severity FROM feedback WHERE id = $1`, ['fb_test_1'])
  assert.equal(row.rows.length, 1)
  assert.equal(row.rows[0].status, 'new')
  assert.equal(row.rows[0].severity, 'high')

  await query(`UPDATE feedback SET status = 'triaged', note = 'reproduced' WHERE id = $1`, ['fb_test_1'])
  const after = await query(`SELECT status, note FROM feedback WHERE id = $1`, ['fb_test_1'])
  assert.equal(after.rows[0].status, 'triaged')
  assert.equal(after.rows[0].note, 'reproduced')
})
