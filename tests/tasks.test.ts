process.env.PGLITE_DIR = 'memory://'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const {
  createTask,
  claimTask,
  completeTask,
  failTask,
  listTasksByPipeline,
  newTaskId,
  TaskConflictError,
} = await import('../src/agents/tasks.js')

/**
 * The durable task spine is only worth having if the state machine cannot be talked out of its
 * guardrails, so these tests exercise the refusals as much as the happy path: a second claim must
 * lose, a queued task must not be completable, and a failed attempt must be counted.
 *
 * Every row here carries one run-scoped correlation id and is deleted afterwards, so the file can
 * run twice against a file-backed PGlite directory without inheriting state from the first run.
 */
describe('PH2-004 durable task spine', () => {
  const correlationId = `corr_tasks_${randomUUID()}`
  const pipelineId = `pipe_tasks_${randomUUID()}`
  const created: string[] = []

  async function make(overrides: Record<string, unknown> = {}) {
    const row = await createTask({
      correlationId,
      title: 'verify the patch',
      instruction: 'run the focused suite and report the result',
      pipelineId,
      ...overrides,
    })
    created.push(row.id)
    return row
  }

  before(async () => {
    await migrate()
  })

  after(async () => {
    await query(`DELETE FROM agent_tasks WHERE correlation_id = $1`, [correlationId])
    const left = (await one(`SELECT count(*)::int AS n FROM agent_tasks WHERE correlation_id = $1`, [correlationId])) as { n: number }
    assert.equal(left.n, 0, 'the test should clean up after itself')
  })

  it('creates a task queued at attempt 1 with no owner and no start time', async () => {
    const task = await make()
    assert.match(task.id, /^tsk_[0-9a-f]{24}$/)
    assert.equal(task.status, 'queued')
    assert.equal(task.attempt, 1)
    assert.equal(task.owner_agent_id, null)
    assert.equal(task.started_at, null)
    assert.equal(task.completed_at, null)
    assert.equal(task.result, null)
    assert.equal(task.error, null)
    assert.deepEqual(task.artifacts, [])
    assert.equal(task.correlation_id, correlationId)
    assert.equal(task.pipeline_id, pipelineId)
  })

  it('claims a queued task: in_progress, owned, started_at stamped', async () => {
    const task = await make()
    const claimed = await claimTask(task.id, 'agent_qa')
    assert.ok(claimed)
    assert.equal(claimed!.id, task.id)
    assert.equal(claimed!.status, 'in_progress')
    assert.equal(claimed!.owner_agent_id, 'agent_qa')
    assert.ok(claimed!.started_at, 'claim must stamp started_at')
    assert.ok(claimed!.updated_at, 'claim must stamp updated_at')
  })

  it('refuses a second claim and leaves the row owned by the first claimer', async () => {
    const task = await make()
    const first = await claimTask(task.id, 'agent_qa')
    assert.ok(first)
    const second = await claimTask(task.id, 'agent_backend')
    assert.equal(second, null)
    const row = (await one(`SELECT * FROM agent_tasks WHERE id = $1`, [task.id])) as any
    assert.equal(row.status, 'in_progress')
    assert.equal(row.owner_agent_id, 'agent_qa')
    // PGlite hands timestamps back as Date, the row type says string: compare the instant.
    assert.equal(new Date(row.started_at).toISOString(), new Date(first!.started_at as any).toISOString())
  })

  it('lets exactly one of two concurrent claimers win', async () => {
    const task = await make()
    const [a, b] = await Promise.all([claimTask(task.id, 'agent_qa'), claimTask(task.id, 'agent_backend')])
    const winners = [a, b].filter(Boolean)
    assert.equal(winners.length, 1, 'two concurrent claims must not both succeed')
    const row = (await one(`SELECT * FROM agent_tasks WHERE id = $1`, [task.id])) as any
    assert.equal(row.owner_agent_id, winners[0]!.owner_agent_id)
  })

  it('completes an in_progress task and stores the result', async () => {
    const task = await make()
    await claimTask(task.id, 'agent_qa')
    const done = await completeTask(task.id, { verdict: 'pass', tests: 12 })
    assert.equal(done.status, 'completed')
    assert.deepEqual(done.result, { verdict: 'pass', tests: 12 })
    assert.ok(done.completed_at, 'completion must stamp completed_at')
    assert.ok(done.updated_at, 'completion must stamp updated_at')
    const row = (await one(`SELECT status, result FROM agent_tasks WHERE id = $1`, [task.id])) as any
    assert.equal(row.status, 'completed')
    assert.deepEqual(row.result, { verdict: 'pass', tests: 12 })
  })

  it('refuses to complete a queued task', async () => {
    const task = await make()
    await assert.rejects(
      () => completeTask(task.id, { verdict: 'pass' }),
      (err: any) => {
        assert.ok(err instanceof TaskConflictError)
        assert.equal(err.code, 'not_in_progress')
        assert.equal(err.status, 'queued')
        return true
      }
    )
    const row = (await one(`SELECT status, result, completed_at FROM agent_tasks WHERE id = $1`, [task.id])) as any
    assert.equal(row.status, 'queued', 'a refused completion must not move the row')
    assert.equal(row.result, null)
    assert.equal(row.completed_at, null)
  })

  it('records a failure and increments the attempt counter', async () => {
    const task = await make()
    await claimTask(task.id, 'agent_qa')
    const failed = await failTask(task.id, 'focused suite failed: 2 of 12')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, 'focused suite failed: 2 of 12')
    assert.equal(failed.attempt, 2, 'a failed attempt must be counted as rework')
    assert.ok(failed.updated_at)
    const row = (await one(`SELECT attempt, status, error FROM agent_tasks WHERE id = $1`, [task.id])) as any
    assert.equal(row.attempt, 2)
    assert.equal(row.status, 'failed')
    assert.equal(row.error, 'focused suite failed: 2 of 12')
  })

  it('lists only one pipeline, oldest first', async () => {
    const otherPipeline = `pipe_other_${randomUUID()}`
    const base = Date.now()
    const mine = [
      await make({ title: 'first' }),
      await make({ title: 'second' }),
      await make({ title: 'third' }),
    ]
    const stranger = await make({ title: 'elsewhere', pipelineId: otherPipeline })
    // created_at is set explicitly: three inserts in one millisecond would not prove ordering.
    for (const [i, t] of mine.entries()) {
      await query(`UPDATE agent_tasks SET created_at = $2 WHERE id = $1`, [t.id, new Date(base + i * 1000).toISOString()])
    }
    const rows = await listTasksByPipeline(pipelineId)
    const titles = rows.filter((r) => mine.some((m) => m.id === r.id)).map((r) => r.title)
    assert.deepEqual(titles, ['first', 'second', 'third'])
    assert.ok(rows.every((r) => r.pipeline_id === pipelineId), 'only this pipeline may appear')
    assert.ok(!rows.some((r) => r.id === stranger.id), 'a task from another pipeline must not leak in')
    const times = rows.map((r) => new Date(r.created_at).getTime())
    assert.deepEqual(times, [...times].sort((x, y) => x - y), 'rows must be oldest first')
  })

  it('generates distinct addresses', () => {
    assert.notEqual(newTaskId(), newTaskId())
  })
})
