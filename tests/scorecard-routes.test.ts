/**
 * The two behaviours the source-grep tests pretended to cover, exercised as requests:
 * the master-key gate on the scorecard, and the ops path's refusal of an undeclared pipeline_id.
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.DATABASE_URL
delete process.env.DATABASE_URL_UNPOOLED
delete process.env.PREVIEW_DATABASE_URL
process.env.PGLITE_DIR = join(mkdtempSync(join(tmpdir(), 'scorecard-routes-')), 'db')
// The cron route compares against env.cronSecret, which must exist before env.ts is imported.
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret'

import { Hono } from 'hono'
import type { AppEnv } from '../src/lib/types.js'

const { migrate, query } = await import('../src/db/index.js')
const { env } = await import('../src/lib/env.js')
const { registerAdminRoutes } = await import('../src/routes/admin.js')
const { registerCronRoute } = await import('../src/routes/agents.js')

const adminApp = new Hono<AppEnv>()
registerAdminRoutes(adminApp)
const cronApp = new Hono<AppEnv>()
registerCronRoute(cronApp)

const U = 'u_routes'

describe('scorecard and ops-path behaviour', () => {
  before(async () => {
    await migrate()
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1,'0xroutes','user') ON CONFLICT DO NOTHING`, [U])
    await query(
      `INSERT INTO agents (id,user_id,name,system_prompt,model,budget_usd_micros,max_steps,status)
       VALUES ('tdt_qa',$1,'QA','p','gpt-oss-20b',1000,2,'active') ON CONFLICT DO NOTHING`,
      [U]
    )
  })

  it('refuses the scorecard with no master key', async () => {
    const res = await adminApp.request('/api/admin/agents/scorecard?hours=24')
    assert.equal(res.status, 403)
  })

  it('serves the scorecard with the master key and defaults a non-numeric window to 168', async () => {
    const res = await adminApp.request('/api/admin/agents/scorecard?hours=banana', {
      headers: { 'x-master-key': env.masterKey },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as any
    assert.equal(body.window_hours, 168, 'a non-numeric hours must fall back to the documented default')
    assert.equal(body.metrics.length, 6)
  })

  it('refuses a pipeline_id that is not declared, including prototype keys', async () => {
    for (const bad of ['nope', 'constructor', '__proto__']) {
      const res = await cronApp.request('/api/cron/agents', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.cronSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'tdt_qa', input: 'probe the pipeline gate', pipeline_id: bad }),
      })
      assert.equal(res.status, 400, `pipeline_id ${bad} must be refused`)
      const body = (await res.json()) as any
      assert.match(body.error.message, /Unknown pipeline_id/)
    }
  })

  it('does not leave the idempotency slot locked after refusing a bad pipeline_id', async () => {
    const payload = { agent_id: 'tdt_qa', input: 'probe the lock', pipeline_id: 'nope', idempotency_key: 'k1' }
    const first = await cronApp.request('/api/cron/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.cronSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(first.status, 400)
    const held = await query(`SELECT count(*)::int AS n FROM agent_schedule_lock WHERE lock_key = 'ops:k1'`)
    assert.equal((held.rows[0] as any).n, 0, 'a refused request must not hold the slot')
  })
})
