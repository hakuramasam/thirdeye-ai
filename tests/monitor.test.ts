import assert from 'node:assert/strict'
import { test } from 'node:test'

const { detectFindings, dedupeKey, scrub, claimsSuccess, showsEvidence } = await import('../src/agents/monitor.js')

const now = Date.parse('2026-11-10T12:00:00Z')
const run = (over: any = {}) => ({
  id: over.id ?? 'r1', agent_id: over.agent_id ?? 'tdt_qa', status: over.status ?? 'completed',
  input: 'task', output: over.output ?? null, error: over.error ?? null,
  tool_calls: over.tool_calls ?? 1, spend_usd_micros: over.spend_usd_micros ?? 100,
  created_at: over.created_at ?? '2026-11-10T11:50:00Z',
})
const codes = (f: any[]) => f.map((x) => x.code).sort()

test('a claim without a measurement is an alert, a claim with one is not', () => {
  assert.equal(claimsSuccess('Everything is fixed and deployed.'), true)
  assert.equal(showsEvidence('Everything is fixed and deployed.'), false)
  const bad = detectFindings([run({ output: 'Fixed and deployed.' })], [], { now })
  assert.ok(codes(bad).includes('unverified_claim'))

  const good = detectFindings([run({ output: 'Deployed d893d0e; healthz 200; 236/236 tests.' })], [], { now })
  assert.equal(codes(good).includes('unverified_claim'), false)
})

test('a run still marked running past the stale window is an alert', () => {
  const f = detectFindings([run({ status: 'running', created_at: '2026-11-10T11:00:00Z' })], [], { now, staleMinutes: 15 })
  assert.deepEqual(codes(f).filter((c: string) => c === 'stuck_run'), ['stuck_run'])
  const fresh = detectFindings([run({ status: 'running', created_at: '2026-11-10T11:58:00Z' })], [], { now, staleMinutes: 15 })
  assert.equal(codes(fresh).includes('stuck_run'), false)
})

test('money spent with no tool call is flagged as silent spend', () => {
  const f = detectFindings([run({ tool_calls: 0, spend_usd_micros: 500, output: 'thinking' })], [], { now })
  assert.ok(codes(f).includes('silent_spend'))
})

test('a refused write is surfaced with its reason, not swallowed', () => {
  const events = [{ run_id: 'r1', tool: 'repo_write', ok: false, refused: true, result_excerpt: 'Refused: money path src/lib/billing.ts' }]
  const f = detectFindings([run({ output: 'Attempted the fix.' })], events, { now })
  const wr = f.find((x: any) => x.code === 'write_refused')
  assert.ok(wr)
  assert.match(String(wr!.summary), /money path/)
})

test('a write with no verification is flagged, and a verified one is not', () => {
  const wrote = [{ run_id: 'r1', tool: 'repo_write', ok: true, refused: false }]
  const f = detectFindings([run({ output: 'Opened a pull request.' })], wrote, { now })
  assert.ok(codes(f).includes('write_without_verify'))

  const f2 = detectFindings([run({ output: 'PR #14 open, tsc clean, 242/242 tests.' })], wrote, { now })
  assert.equal(codes(f2).includes('write_without_verify'), false)
})

test('budget overrun and repeated failure are detected', () => {
  const f = detectFindings([run({ spend_usd_micros: 99_999 })], [], { now, budgets: { tdt_qa: 15_000 } })
  assert.ok(codes(f).includes('budget_overrun'))

  const fails = [1, 2, 3].map((i) => run({ id: `f${i}`, status: 'error', error: 'boom' }))
  assert.ok(codes(detectFindings(fails, [], { now })).includes('repeat_failure'))
})

test('dedupe key is stable per condition and run, so one fault alerts once', () => {
  const a = { code: 'stuck_run', run_id: 'r9', agent_id: 'tdt_qa', severity: 'high' as const, summary: '', evidence: {} }
  const b = { ...a, summary: 'different wording' }
  assert.equal(dedupeKey(a), dedupeKey(b))
})

test('scrub removes credential shapes before they reach a log row', () => {
  const dirty = 'auth: Bearer sk-thirdeye-mCQZidJ8C6edifI2Wa7LrAtJO1inqdVprhu1BI2Itzp5laDA and AKIAABCDEFGHIJKLMNOP and ghp_abcdefghijklmnopqrstuvwx'
  const clean = scrub(dirty)
  assert.ok(!clean.includes('mCQZidJ8'))
  assert.ok(!clean.includes('AKIAABCDEFGHIJ'))
  assert.ok(!clean.includes('ghp_abcdefghij'))
  assert.match(clean, /sk-\*\*\*/)
})
