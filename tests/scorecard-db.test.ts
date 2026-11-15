/**
 * The scorecard's SQL against a real (embedded) database. The pure tests prove the arithmetic; only
 * this proves the queries select the columns the arithmetic reads, which a fixture can never do.
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.DATABASE_URL
delete process.env.DATABASE_URL_UNPOOLED
// env.ts prefers PREVIEW_DATABASE_URL, so an inherited value would point this suite at a real database.
delete process.env.PREVIEW_DATABASE_URL
process.env.PGLITE_DIR = join(mkdtempSync(join(tmpdir(), 'scorecard-')), 'db')
const { migrate, query } = await import('../src/db/index.js')
const { scorecardReport } = await import('../src/agents/scorecard.js')

const U = 'u_scorecard'
const run = (id: string, agent: string, status: string, micros: number, hoursAgo: number) =>
  query(
    `INSERT INTO agent_runs (id,agent_id,user_id,status,input,spend_usd_micros,created_at)
     VALUES ($1,$2,$3,$4,'x',$5, now() - ($6 || ' hours')::interval)`,
    [id, agent, U, status, micros, String(hoursAgo)]
  )

describe('scorecard against the real schema', () => {
  before(async () => {
    await migrate()
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1,'0xscore','user') ON CONFLICT DO NOTHING`, [U])
    for (const a of ['tdt_qa', 'tdt_backend', 'legacy_watcher']) {
      await query(
        `INSERT INTO agents (id,user_id,name,system_prompt,model,budget_usd_micros,max_steps)
         VALUES ($1,$2,$1,'p','gpt-oss-20b',1000,2) ON CONFLICT DO NOTHING`,
        [a, U]
      )
    }
    // current 24h window: a failure that recovers, plus a clean success
    await run('c1', 'tdt_qa', 'error', 400, 5)
    await run('c2', 'tdt_qa', 'success', 100, 3)
    await run('c3', 'tdt_backend', 'success', 100, 2)
    // previous window: everything failed
    await run('p1', 'tdt_qa', 'error', 300, 30)
    await run('p2', 'tdt_backend', 'error', 300, 40)
    // a non-team agent that must not be scored
    await run('x1', 'legacy_watcher', 'success', 9_000_000, 1)
  })

  it('runs every query without a schema error and returns all six measures', async () => {
    const r = await scorecardReport(24)
    assert.equal(r.metrics.length, 6)
    assert.equal(r.window_hours, 24)
  })

  it('scores only team agents, never the legacy ones', async () => {
    const r = await scorecardReport(24)
    assert.deepEqual(r.agents.map((a: any) => a.agent_id).sort(), ['tdt_backend', 'tdt_qa'])
    const cost = r.metrics.find((m: any) => m.id === 'budget_efficiency')!
    assert.equal(cost.numerator, 600, 'the 9,000,000 micro legacy run must not leak into team cost')
  })

  it('computes recovery from the real rows and compares it with the previous window', async () => {
    const r = await scorecardReport(24)
    const rec = r.metrics.find((m: any) => m.id === 'recovery_rate')!
    assert.equal(rec.value, 1, 'the qa failure was followed by a qa success inside the window')
    assert.equal(rec.previous, 0, 'in the previous window both failures stayed failed')
    assert.equal(rec.trend, 'improving')
  })

  it('reports the pipeline measures as not measurable when no stage events exist', async () => {
    const r = await scorecardReport(24)
    for (const id of ['first_pass_success', 'rework_rate']) {
      assert.equal(r.metrics.find((m: any) => m.id === id)!.status, 'not_measurable', id)
    }
    assert.ok(r.gaps.length >= 2)
  })

  it('clamps an absurd window instead of scanning the whole table', async () => {
    assert.equal((await scorecardReport(10_000_000)).window_hours, 24 * 90)
    assert.equal((await scorecardReport(0)).window_hours, 24)
  })
})
