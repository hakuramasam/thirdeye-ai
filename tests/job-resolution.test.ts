process.env.PGLITE_DIR = 'memory://'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const { migrate, query, one } = await import('../src/db/index.js')
const { createTask } = await import('../src/agents/tasks.js')
const {
  JOB_RESOLUTION_WORKFLOW,
  JOB_RESOLUTION_PIPELINE_ID,
  StageOrderError,
  jobStages,
  jobStageIds,
  nextStageId,
  getJobStage,
  validateJobWorkflow,
  openJob,
  advanceJob,
  walkJob,
  readJob,
  frontierStage,
} = await import('../src/agents/job-resolution.js')

/**
 * `team/workflows/job-resolution.workflow.json` was dead config: valid JSON that no `src/` module
 * imported, so its nine steps could be followed or ignored with no durable trace either way.
 * These tests are the proof that it is now the queue — the file on disk and the imported document
 * agree, the validator refuses the shapes that would make a walk ambiguous, a simulated job
 * produces one completed row per stage in declared order, and a jump is refused rather than
 * quietly accepted.
 *
 * Every row carries a run-scoped correlation prefix and is deleted afterwards, so the file can run
 * twice against a file-backed PGlite directory without inheriting state from the first run.
 */
describe('PH2-005 job resolution queue', () => {
  const runId = randomUUID()
  const correlationPrefix = `corr_jobres_${runId}_`
  let jobSeq = 0

  function nextCorrelation(): string {
    jobSeq += 1
    return `${correlationPrefix}${jobSeq}`
  }

  before(async () => {
    await migrate()
  })

  after(async () => {
    await query(`DELETE FROM agent_tasks WHERE correlation_id LIKE $1`, [`${correlationPrefix}%`])
    const left = (await one(`SELECT count(*)::int AS n FROM agent_tasks WHERE correlation_id LIKE $1`, [
      `${correlationPrefix}%`,
    ])) as { n: number }
    assert.equal(left.n, 0, 'the test should clean up after itself')
  })

  it('loads the workflow file from team/workflows and agrees with the file on disk', () => {
    const onDisk = JSON.parse(
      readFileSync(new URL('../team/workflows/job-resolution.workflow.json', import.meta.url), 'utf8')
    ) as { id: string; steps: Array<{ id: string; owner: string }> }

    assert.equal(JOB_RESOLUTION_WORKFLOW.id, 'job-resolution')
    assert.equal(JOB_RESOLUTION_PIPELINE_ID, 'job-resolution')
    assert.equal(JOB_RESOLUTION_WORKFLOW.id, onDisk.id, 'the imported document must be the file on disk')
    assert.deepEqual(jobStageIds(), onDisk.steps.map((step) => step.id))
    assert.deepEqual(validateJobWorkflow(JOB_RESOLUTION_WORKFLOW), [], 'the shipped workflow must be walkable')
    assert.ok(jobStages().length > 0, 'a queue with no stages is not a queue')
  })

  it('declares unique stage ids', () => {
    const ids = jobStageIds()
    assert.equal(new Set(ids).size, ids.length, 'stage ids must be unique or a row cannot name its stage')

    const duplicated = {
      id: 'job-resolution',
      steps: [
        { n: 1, id: 'intake', owner: 'tdt_hermes', title: 'Intake' },
        { n: 2, id: 'intake', owner: 'tdt_product', title: 'Intake again' },
      ],
    }
    const problems = validateJobWorkflow(duplicated)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /declared twice/)
  })

  it('refuses a stage that names no owner', () => {
    const problems = validateJobWorkflow({
      id: 'job-resolution',
      steps: [{ n: 1, id: 'intake', title: 'Intake' }],
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /names no owner/)
  })

  it('refuses a workflow whose declared order is empty or only implied', () => {
    assert.match(validateJobWorkflow({ id: 'job-resolution', steps: [] }).join(' '), /declares no steps/)

    const implied = validateJobWorkflow({
      id: 'job-resolution',
      steps: [
        { id: 'intake', owner: 'tdt_hermes', title: 'Intake' },
        { id: 'design', owner: 'tdt_architect', title: 'Design' },
      ],
    })
    assert.equal(implied.length, 2, 'both missing positions must be reported')
    assert.ok(implied.every((problem) => /declares no position/.test(problem)))

    const reordered = validateJobWorkflow({
      id: 'job-resolution',
      steps: [
        { n: 1, id: 'intake', owner: 'tdt_hermes', title: 'Intake' },
        { n: 3, id: 'design', owner: 'tdt_architect', title: 'Design' },
      ],
    })
    assert.match(reordered.join(' '), /declares n=3 at position 2/)
  })

  it('derives each next stage from the current one, never from a caller argument', () => {
    const ids = jobStageIds()
    assert.equal(nextStageId(ids[0]), ids[1])
    assert.equal(nextStageId(ids[ids.length - 2]), ids[ids.length - 1])
    assert.equal(nextStageId(ids[ids.length - 1]), null, 'the last stage ends the walk')

    // Walking the derivation alone reproduces the declared order exactly.
    const walked: string[] = [ids[0]]
    for (let cursor = nextStageId(ids[0]); cursor; cursor = nextStageId(cursor)) walked.push(cursor)
    assert.deepEqual(walked, ids)
    assert.equal(advanceJob.length, 2, 'advanceJob takes (taskId, output): there is no stage argument to jump with')

    assert.throws(
      () => nextStageId('not_a_stage'),
      (err: any) => err instanceof StageOrderError && err.code === 'stage_unknown'
    )
    assert.equal(getJobStage(null), null)
  })

  it('walks every stage to completion, one completed row per stage', async () => {
    const correlationId = nextCorrelation()
    const visited: string[] = []

    const walked = await walkJob(
      { correlationId, title: 'Build a wallet management dashboard', priority: 'high' },
      (stage) => {
        visited.push(stage.id)
        return { stage: stage.id, verdict: 'pass' }
      }
    )

    assert.equal(walked.completed, true)
    assert.deepEqual(visited, jobStageIds(), 'every stage must run, in declared order')
    assert.deepEqual(walked.stages, jobStageIds())
    assert.equal(walked.rows.length, jobStageIds().length, 'exactly one row per stage')

    const rows = await readJob(correlationId)
    assert.equal(rows.length, jobStageIds().length)
    assert.deepEqual(rows.map((row) => row.stage_id), jobStageIds())

    for (const [index, row] of rows.entries()) {
      const stage = jobStages()[index]
      assert.equal(row.status, 'completed', `${row.stage_id} must reach completed`)
      assert.equal(row.pipeline_id, JOB_RESOLUTION_PIPELINE_ID)
      assert.equal(row.correlation_id, correlationId)
      assert.equal(row.owner_agent_id, stage.owner, `${row.stage_id} must be owned by its declared owner`)
      assert.equal(row.attempt, 1, 'a clean walk is first-pass work')
      assert.ok(row.started_at, `${row.stage_id} must record when work began`)
      assert.ok(row.completed_at, `${row.stage_id} must record when it finished`)
      assert.deepEqual((row.result as any).stage, stage.id)
      assert.equal((row.result as any).owner, stage.owner)
      assert.equal(row.priority, 'high', 'priority is inherited from the job')
      if (index > 0) assert.equal(row.parent_task_id, rows[index - 1].id, 'each stage hands on to the next')
    }

    assert.equal(await frontierStage(correlationId), null, 'a finished job has no frontier')
  })

  it('refuses a stage that jumps ahead of the frontier', async () => {
    const correlationId = nextCorrelation()
    const { task: intake } = await openJob({ correlationId, title: 'jump attempt' })

    // A later stage row is created deliberately, as a caller trying to jump would have to.
    const jumped = await createTask({
      correlationId,
      pipelineId: JOB_RESOLUTION_PIPELINE_ID,
      stageId: 'release',
      title: 'Release to production (release)',
      instruction: 'skip the seven stages before this one',
    })

    await assert.rejects(
      () => advanceJob(jumped.id, { verdict: 'shipped' }),
      (err: any) => {
        assert.ok(err instanceof StageOrderError)
        assert.equal(err.code, 'stage_out_of_order')
        assert.match(err.message, /"intake" is unfinished/)
        return true
      }
    )

    const afterRefusal = await readJob(correlationId)
    assert.equal(afterRefusal.length, 2)
    assert.ok(afterRefusal.every((row) => row.status === 'queued'), 'a refused jump must not complete anything')
    assert.equal((await frontierStage(correlationId))!.stage.id, 'intake')

    // Even one stage in, release is still not reachable: the frontier moves, it does not disappear.
    const step = await advanceJob(intake.id, { verdict: 'intake done' })
    assert.equal(step.next!.stage.id, 'define_success')
    await assert.rejects(
      () => advanceJob(jumped.id, { verdict: 'shipped' }),
      (err: any) => err instanceof StageOrderError && err.code === 'stage_out_of_order' && /"define_success" is unfinished/.test(err.message)
    )
    assert.equal((await one(`SELECT status FROM agent_tasks WHERE id = $1`, [jumped.id]) as any).status, 'queued')
  })

  it('refuses a task outside the workflow, and a completed job', async () => {
    const correlationId = nextCorrelation()
    const { task } = await openJob({ correlationId, title: 'refusals' })

    await assert.rejects(
      () => advanceJob('tsk_does_not_exist', {}),
      (err: any) => err instanceof StageOrderError && err.code === 'task_not_found'
    )

    const stranger = await createTask({
      correlationId,
      pipelineId: 'feature',
      stageId: 'intake',
      title: 'not a job-resolution row',
      instruction: 'belongs to another pipeline',
    })
    await assert.rejects(
      () => advanceJob(stranger.id, {}),
      (err: any) => err instanceof StageOrderError && err.code === 'not_job_resolution'
    )

    const walked = await walkJob({ correlationId: nextCorrelation(), title: 'completed twice' }, () => ({ ok: true }))
    const last = walked.rows[walked.rows.length - 1]
    await assert.rejects(
      () => advanceJob(last.id, {}),
      (err: any) => err instanceof StageOrderError && err.code === 'job_complete'
    )

    assert.equal((await one(`SELECT status FROM agent_tasks WHERE id = $1`, [task.id]) as any).status, 'queued')
  })
})
