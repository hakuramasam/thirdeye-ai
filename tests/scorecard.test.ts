import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildScorecard, firstPass, perAgent, recovery, stageRework, trend, type RunInput, type StageEventInput } from '../src/agents/scorecard.js'

const t = (h: number) => new Date(Date.UTC(2026, 10, 15, h)).toISOString()
const run = (id: string, agent: string, status: string, micros = 100, h = 0): RunInput =>
  ({ id, agent_id: agent, status, spend_usd_micros: micros, created_at: t(h) })
let seq = 0
const ev = (corr: string, stage: string, type: StageEventInput['event_type']): StageEventInput =>
  ({ correlation_id: corr, stage_id: stage, event_type: type, insert_seq: ++seq })
const get = (card: ReturnType<typeof buildScorecard>, id: string) => card.metrics.find((m) => m.id === id)!

test('an empty ledger reports every ledger-backed metric as not measurable, never 0 or 100 percent', () => {
  const card = buildScorecard({ runs: [], stageEvents: [], taskEvents: [], alerts: [] })
  for (const id of ['task_completion', 'first_pass_success', 'rework_rate', 'budget_efficiency', 'recovery_rate']) {
    const m = get(card, id)
    assert.equal(m.status, 'not_measurable', id)
    assert.equal(m.value, null, `${id} must not carry a number it cannot support`)
    assert.ok(m.basis.length > 20, `${id} must say why`)
  }
  assert.equal(get(card, 'security_quality').value, 0, 'zero blockers is a real measurement')
})

test('production today: runs exist but no stage events, so first-pass and rework are refused rather than invented', () => {
  const runs = [run('a', 'tdt_hermes', 'error'), run('b', 'tdt_backend', 'success'), run('c', 'tdt_qa', 'success')]
  const card = buildScorecard({ runs, stageEvents: [], taskEvents: [], alerts: [] })
  assert.equal(get(card, 'first_pass_success').value, null)
  assert.equal(get(card, 'rework_rate').value, null)
  assert.match(get(card, 'first_pass_success').basis, /stage\.\* events/)
  assert.equal(get(card, 'budget_efficiency').status, 'measured')
})

test('first-pass counts a job only when verify passed and build ran once', () => {
  const events = [
    ev('j1', 'build', 'stage.started'), ev('j1', 'build', 'stage.completed'), ev('j1', 'verify', 'stage.started'), ev('j1', 'verify', 'stage.completed'),
    ev('j2', 'build', 'stage.started'), ev('j2', 'verify', 'stage.started'), ev('j2', 'verify', 'stage.failed'),
    ev('j2', 'build', 'stage.started'), ev('j2', 'build', 'stage.completed'), ev('j2', 'verify', 'stage.started'), ev('j2', 'verify', 'stage.completed'),
  ]
  const fp = firstPass(events)
  assert.equal(fp.reachedVerify, 2)
  assert.equal(fp.passedFirst, 1, 'j2 passed eventually but only after rework, so it is not first-pass')
})

test('rework counts a stage started twice for the same job, not the same stage in different jobs', () => {
  const events = [
    ev('j1', 'build', 'stage.started'), ev('j1', 'build', 'stage.started'),
    ev('j2', 'build', 'stage.started'), ev('j3', 'build', 'stage.started'),
  ]
  const r = stageRework(events)
  assert.equal(r.stages, 3)
  assert.equal(r.reworked, 1)
  const card = buildScorecard({ runs: [], stageEvents: events, taskEvents: [], alerts: [] })
  assert.equal(get(card, 'rework_rate').value, 1 / 3)
})

test('cost per success includes the money wasted on failed runs', () => {
  const runs = [run('a', 'x', 'error', 900_000), run('b', 'x', 'success', 100_000)]
  const card = buildScorecard({ runs, stageEvents: [], taskEvents: [], alerts: [] })
  assert.equal(get(card, 'budget_efficiency').value, 1.0, '$1.00 total over one success, not $0.10')
})

test('cost per success is unbounded, not zero, when nothing succeeded', () => {
  const card = buildScorecard({ runs: [run('a', 'x', 'error', 5000)], stageEvents: [], taskEvents: [], alerts: [] })
  assert.equal(get(card, 'budget_efficiency').value, null)
  assert.match(get(card, 'budget_efficiency').basis, /none succeeded/)
})

test('recovery requires a later success by the same agent within the window', () => {
  const runs = [
    run('f1', 'a', 'error', 1, 0), run('s1', 'a', 'success', 1, 2),
    run('f2', 'b', 'error', 1, 0), run('s2', 'c', 'success', 1, 2),
    run('f3', 'd', 'error', 1, 0), run('s3', 'd', 'success', 1, 0 + 30),
  ]
  const r = recovery(runs)
  assert.equal(r.failures, 3)
  assert.equal(r.recovered, 1, 'only agent a recovered inside 26h; c is another agent and d came too late')
})

test('a still-running run is neither a failure nor a recovery', () => {
  assert.equal(recovery([run('r', 'a', 'running')]).failures, 0)
})

test('security quality counts only unacknowledged high alerts', () => {
  const alerts = [
    { code: 'x', severity: 'high' as const, acknowledged_at: null, created_at: t(1) },
    { code: 'y', severity: 'high' as const, acknowledged_at: t(2), created_at: t(1) },
    { code: 'z', severity: 'medium' as const, acknowledged_at: null, created_at: t(1) },
  ]
  assert.equal(get(buildScorecard({ runs: [], stageEvents: [], taskEvents: [], alerts }), 'security_quality').value, 1)
})

test('task completion needs a delegation to exist and matches by task id', () => {
  const taskEvents = [
    { correlation_id: 'c', task_id: 't1', event_type: 'task.delegated' as const },
    { correlation_id: 'c', task_id: 't2', event_type: 'task.delegated' as const },
    { correlation_id: 'c', task_id: 't1', event_type: 'task.completed' as const },
    { correlation_id: 'c', task_id: 't9', event_type: 'task.completed' as const },
  ]
  const m = get(buildScorecard({ runs: [], stageEvents: [], taskEvents, alerts: [] }), 'task_completion')
  assert.equal(m.value, 0.5, 'a completion with no matching delegation must not inflate the rate')
})

test('volume never raises a score: a busy failing agent ranks below a quiet reliable one', () => {
  const runs: RunInput[] = []
  for (let i = 0; i < 40; i++) runs.push(run(`b${i}`, 'busy', i % 10 === 0 ? 'success' : 'error', 500))
  runs.push(run('q1', 'quiet', 'success', 100), run('q2', 'quiet', 'success', 100))
  const ranked = perAgent(runs)
  assert.equal(ranked[0].agent_id, 'quiet')
  assert.ok(ranked[0].success_rate! > ranked[1].success_rate!)
  assert.equal('runs_per_day' in ranked[0], false)
})

test('there is no metric named for lines of code, pull request count or speed', () => {
  const ids = buildScorecard({ runs: [], stageEvents: [], taskEvents: [], alerts: [] }).metrics.map((m) => m.id.toLowerCase()).join(' ')
  for (const banned of ['loc', 'lines', 'pr_count', 'prs', 'speed', 'velocity', 'throughput', 'commits']) {
    assert.equal(ids.includes(banned), false, `${banned} rewards volume`)
  }
})

test('trend is unknown unless both windows are measured, and honours which direction is better', () => {
  const m = (value: number | null, better: 'higher' | 'lower') =>
    ({ id: 'x', label: 'x', value, unit: 'ratio' as const, status: value === null ? 'not_measurable' as const : 'measured' as const, basis: 'b', better })
  assert.equal(trend(m(null, 'higher'), m(0.9, 'higher')), 'unknown')
  assert.equal(trend(m(0.5, 'higher'), m(0.7, 'higher')), 'improving')
  assert.equal(trend(m(0.5, 'lower'), m(0.7, 'lower')), 'worsening')
  assert.equal(trend(m(0.2, 'lower'), m(0.1, 'lower')), 'improving')
  assert.equal(trend(m(0.3, 'higher'), m(0.3, 'higher')), 'flat')
})

test('the headline states how many measures are actually backed', () => {
  const card = buildScorecard({ runs: [run('a', 'x', 'success')], stageEvents: [], taskEvents: [], alerts: [] })
  assert.match(card.headline, /of 6 measures are backed by the ledger/)
})

test('a ratio over fewer than five observations is flagged thin so one task cannot read as a rate', () => {
  const taskEvents = [
    { correlation_id: 'c', task_id: 't1', event_type: 'task.delegated' as const },
    { correlation_id: 'c', task_id: 't1', event_type: 'task.completed' as const },
  ]
  const card = buildScorecard({ runs: [], stageEvents: [], taskEvents, alerts: [] })
  const m = get(card, 'task_completion')
  assert.equal(m.value, 1)
  assert.equal(m.confidence, 'thin')
  assert.match(card.headline, /rest on fewer than 5 observations/)
})

test('five or more observations are adequate', () => {
  // the denominator of cost per success is the number of SUCCESSES, so five successes are needed
  const runs = [1, 2, 3, 4, 5, 6].map((i) => run(`r${i}`, 'a', i === 1 ? 'error' : 'success'))
  assert.equal(get(buildScorecard({ runs, stageEvents: [], taskEvents: [], alerts: [] }), 'budget_efficiency').confidence, 'adequate')
})

import { readFileSync } from 'node:fs'
test('the scorecard route is master-key gated and has no volume figure', () => {
  const src = readFileSync('src/routes/admin.ts', 'utf8')
  const block = src.slice(src.indexOf("'/api/admin/agents/scorecard'"))
  assert.match(block.slice(0, 260), /x-master-key/)
  assert.doesNotMatch(block, /runs_per|lines_of_code|pr_count/)
})

test('the ops path accepts only a declared pipeline id, so stage recording can switch on', () => {
  const src = readFileSync('src/routes/agents.ts', 'utf8')
  assert.match(src, /getPipeline\(pipelineId\)/)
  assert.match(src, /Unknown pipeline_id/)
  assert.match(src, /pipelineId \? \{ pipelineId \}/)
})
