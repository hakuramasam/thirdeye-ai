process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const { runAgent } = await import('../src/agents/runner.js')
const { readAuditEvents, newCorrelationId, recordStageTransition } = await import('../src/agents/audit-log.js')
const { PIPELINES, validatePipeline, planNextStage, planForPipeline, ledgerFrom, stageOrder } = await import(
  '../src/agents/pipeline.js'
)
import type { AgentRow } from '../src/agents/runner.js'

const toolCall = (name: string, args: Record<string, unknown>) => ({
  id: `call_${Math.random().toString(16).slice(2)}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
})

function scriptedLlm(script: Array<{ content?: string; tool_calls?: any[] }>) {
  let i = 0
  return {
    call: async () => {
      const step = script[Math.min(i, script.length - 1)]
      i++
      return { content: step.content ?? '', prompt_tokens: 1, completion_tokens: 1, tool_calls: step.tool_calls }
    },
  }
}

type St = { started: number; completed: number; failed: number; skipped: number }
const st = (o: Partial<St> = {}): St => ({ started: 0, completed: 0, failed: 0, skipped: 0, ...o })
/** Typed ledger builder, so the tests cannot quietly pass a half-shaped row. */
const ledgerOf = (rows: Record<string, Partial<St>>): Record<string, St> =>
  Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, st(v)]))

describe('PH2-002 declared pipelines hold their order', () => {
  it('declares the three team pipelines and passes its own validation', () => {
    assert.deepEqual(Object.keys(PIPELINES).sort(), ['bugfix', 'feature', 'incident'])
    for (const doc of Object.values(PIPELINES)) {
      assert.deepEqual(validatePipeline(doc), [], `${doc.id} must validate cleanly`)
    }
  })

  it('keeps stage order as declared, and rejects a forward dependency', () => {
    assert.equal(stageOrder('feature')[0], 'scope')
    assert.deepEqual(stageOrder('bugfix'), ['intake', 'diagnose', 'patch', 'verify', 'security_review', 'release', 'record'])
    const broken = {
      id: 'broken',
      stages: [
        { id: 'first', owner: 'a', gate: 'g', produces: 'x', consumes: ['y'], on_failure: 'stop' as const },
        { id: 'second', owner: 'b', gate: 'g', produces: 'y', consumes: [] },
      ],
    }
    const problems = validatePipeline(broken as any)
    assert.ok(problems.some((p) => p.includes('from its own or a later stage')), problems.join('; '))
  })

  it('refuses a production stage that does not require owner approval', () => {
    const doc = {
      id: 'loose',
      stages: [{ id: 'ship', owner: 'a', gate: 'g', environment: 'production' as const, approval: 'hermes' as const }],
    }
    assert.ok(validatePipeline(doc as any).some((p) => p.includes('without owner approval')))
  })

  it('counts only stage events into the ledger', () => {
    const ledger = ledgerFrom([
      { stage_id: 'scope', event_type: 'stage.started' },
      { stage_id: 'scope', event_type: 'stage.completed' },
      { stage_id: 'design', event_type: 'stage.started' },
      { stage_id: 'design', event_type: 'run.completed' },
      { event_type: 'stage.completed' },
    ])
    assert.deepEqual(ledger, {
      scope: { started: 1, completed: 1, failed: 0, skipped: 0 },
      design: { started: 1, completed: 0, failed: 0, skipped: 0 },
    })
  })

  it('walks the pipeline in order and refuses to run a stage twice at once', () => {
    const first = planForPipeline('feature', {})
    assert.equal(first.ok, true)
    assert.equal(first.ok && first.stage.id, 'scope')
    assert.equal(first.ok && first.attempt, 1)

    const second = planForPipeline('feature', ledgerOf({ scope: { started: 1, completed: 1 } }))
    assert.equal(second.ok && second.stage.id, 'design')

    const inFlight = planForPipeline('feature', ledgerOf({ scope: { started: 1 } }))
    assert.equal(inFlight.ok, false)
    assert.equal(!inFlight.ok && inFlight.code, 'stage_in_flight')
  })

  it('stops a pipeline whose failed stage says stop, and retries one that says back_to_build', () => {
    const stopped = planForPipeline('bugfix', ledgerOf({ intake: { started: 1, failed: 1 } }))
    assert.equal(!stopped.ok && stopped.code, 'pipeline_stopped')

    const retry = planForPipeline('feature', ledgerOf({ scope: { started: 1, completed: 1 }, design: { started: 1, failed: 1 } }))
    assert.equal(retry.ok && retry.stage.id, 'design')
    assert.equal(retry.ok && retry.attempt, 2)

    const exhausted = planForPipeline('feature', ledgerOf({ scope: { started: 1, completed: 1 }, design: { started: 2, failed: 2 } }))
    assert.equal(!exhausted.ok && exhausted.code, 'stage_exhausted')
  })

  it('refuses a stage whose consumed artifact was never produced', () => {
    const plan = planForPipeline('feature', ledgerOf({ scope: { started: 1, completed: 1 }, design: { skipped: 1 } }))
    assert.equal(plan.ok, false)
    assert.equal(!plan.ok && plan.code, 'dependency_unmet')
  })

  it('reports completion instead of inventing more work', () => {
    const ledger = ledgerOf(Object.fromEntries(stageOrder('feature').map((id) => [id, { started: 1, completed: 1 }])))
    const plan = planForPipeline('feature', ledger)
    assert.equal(!plan.ok && plan.code, 'pipeline_complete')
    const unknown = planNextStage(null, {})
    assert.equal(!unknown.ok && unknown.code, 'pipeline_unknown')
  })
})

describe('PH2-002 the runner enforces stage order when a pipeline is declared', () => {
  let user: any
  let hermes: AgentRow
  let product: AgentRow
  let architect: AgentRow

  before(async () => {
    await migrate()
    user = { id: randomUUID(), wallet: `0x${'7'.repeat(40)}`, role: 'user', created_at: new Date().toISOString() }
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      user.id,
      user.wallet,
      user.role,
    ])
    // Ids match the pipeline owners (team/pipelines/*.json), names match the task schema roles,
    // exactly as production registers the team.
    const mk = async (id: string, name: string, canDelegate: boolean) =>
      (await one(
        `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
         VALUES ($1, $2, $3, 'work', 'stub-model', $4, 'none', 100000, 4) RETURNING *`,
        [id, user.id, name, canDelegate]
      )) as AgentRow
    hermes = await mk(`tdt_hermes_${randomUUID().slice(0, 6)}`, 'HERMES', true)
    product = await mk('tdt_product', 'PRODUCT', false)
    architect = await mk('tdt_architect', 'ARCHITECT', false)
  })

  it('gives the delegated run the pipeline stage, and records it as started then completed', async () => {
    const correlationId = newCorrelationId()
    const res = await runAgent(hermes, 'run the first stage', user, {
      correlationId,
      pipelineId: 'feature',
      roster: 'PRODUCT, ARCHITECT',
      llm: scriptedLlm([
        { tool_calls: [toolCall('delegate_to_agent', { agent: 'PRODUCT', task: 'write the acceptance criteria' })] },
        { content: 'scope is done' },
      ]),
    })
    assert.equal(res.status, 'success')

    const events = await readAuditEvents({ correlationId })
    const stageEvents = events.filter((e) => String(e.event_type).startsWith('stage.'))
    assert.deepEqual(
      stageEvents.map((e) => [e.stage_id, e.event_type]),
      [
        ['scope', 'stage.started'],
        ['scope', 'stage.completed'],
      ]
    )
    const childRun = await one(`SELECT id FROM agent_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`, [
      product.id,
    ])
    const childEvents = await readAuditEvents({ runId: childRun.id })
    assert.ok(childEvents.length > 0, 'the child run must be in the trail')
    assert.equal(
      childEvents.every((e) => e.stage_id === 'scope'),
      true,
      'the child must carry the stage it performed'
    )
  })

  it('refuses a delegation to the wrong owner instead of letting the model skip a stage', async () => {
    const correlationId = newCorrelationId()
    const res = await runAgent(hermes, 'try to jump ahead', user, {
      correlationId,
      pipelineId: 'feature',
      roster: 'PRODUCT, ARCHITECT',
      llm: scriptedLlm([{ tool_calls: [toolCall('delegate_to_agent', { agent: 'ARCHITECT', task: 'start the build' })] }, { content: 'blocked' }]),
    })
    assert.equal(res.status, 'success')
    const events = await readAuditEvents({ correlationId })
    assert.equal(events.filter((e) => String(e.event_type).startsWith('stage.')).length, 0, 'a refused stage must not appear as run')
    const denied = events.filter((e) => e.event_type === 'tool.denied')
    assert.equal(denied.length, 1)
    assert.match(String(denied[0].error_summary ?? ''), /expects stage "scope" from tdt_product/)
    const children = await query(`SELECT count(*)::int AS n FROM agent_runs WHERE agent_id = $1`, [architect.id])
    assert.equal(children.rows[0].n, 0, 'no child run may exist for a refused stage')
  })

  it('refuses a stage that is already in flight for the same work', async () => {
    const correlationId = newCorrelationId()
    await recordStageTransition(
      { correlationId, runId: null, agentId: hermes.id, agentRole: hermes.name, pipelineId: 'feature', stageId: 'scope' },
      { stageId: 'scope', eventType: 'stage.started' }
    )
    const res = await runAgent(hermes, 'delegate again', user, {
      correlationId,
      pipelineId: 'feature',
      roster: 'PRODUCT, ARCHITECT',
      llm: scriptedLlm([{ tool_calls: [toolCall('delegate_to_agent', { agent: 'PRODUCT', task: 'redo the scope' })] }, { content: 'waited' }]),
    })
    assert.equal(res.status, 'success')
    const events = await readAuditEvents({ correlationId })
    const denied = events.filter((e) => e.event_type === 'tool.denied')
    assert.ok(denied.length >= 1)
    assert.match(String(denied.at(-1)?.error_summary ?? ''), /already running/)
  })
})
