process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { migrate, query } = await import('../src/db/index.js')
const {
  AUDIT_EVENT_TYPES,
  CRITICAL_EVENT_TYPES,
  AuditUnavailableError,
  createAuditEvent,
  isCriticalEvent,
  newCorrelationId,
  readAuditEvents,
  recordArtifactEvent,
  recordAuthorizationDecision,
  recordRunCompleted,
  recordStageTransition,
  recordToolInvocation,
  redactForAudit,
  scrubAuditText,
} = await import('../src/agents/audit-log.js')

const ctxFor = (runId = `run_${Math.random().toString(16).slice(2)}`) => ({
  correlationId: newCorrelationId(),
  runId,
  agentId: 'tdt_backend',
  agentRole: 'BACKEND',
})

describe('PH2-001 audit log', () => {
  before(async () => {
    await migrate()
  })

  it('generates a distinct correlation id per root execution', () => {
    const a = newCorrelationId()
    const b = newCorrelationId()
    assert.match(a, /^corr_[0-9a-f-]{36}$/)
    assert.notEqual(a, b)
  })

  it('persists every field an execution needs to be reconstructed', async () => {
    const ctx = ctxFor()
    const eventId = await createAuditEvent({
      ...ctx,
      parentRunId: 'run_parent_1',
      taskId: 'task_abc',
      pipelineId: 'feature',
      stageId: 'EXECUTING',
      eventType: 'stage.started',
      status: 'started',
      actorType: 'agent',
      authorizationContext: { allowed: true, reason: 'orchestrator holds write' },
      toolName: 'repo_write',
      artifactIds: ['artifact_1'],
      metadata: { note: 'stage began' },
    })
    assert.ok(eventId && String(eventId).startsWith('evt_'))

    const rows = await readAuditEvents({ correlationId: ctx.correlationId })
    assert.equal(rows.length, 1)
    const row: any = rows[0]
    assert.equal(row.event_id, eventId)
    assert.equal(row.correlation_id, ctx.correlationId)
    assert.equal(row.run_id, ctx.runId)
    assert.equal(row.parent_run_id, 'run_parent_1')
    assert.equal(row.task_id, 'task_abc')
    assert.equal(row.pipeline_id, 'feature')
    assert.equal(row.stage_id, 'EXECUTING')
    assert.equal(row.event_type, 'stage.started')
    assert.equal(row.status, 'started')
    assert.equal(row.agent_id, 'tdt_backend')
    assert.equal(row.tool_name, 'repo_write')
    assert.deepEqual(row.artifact_ids, ['artifact_1'])
    assert.equal(row.authorization_context.allowed, true)
    assert.equal(row.metadata.note, 'stage began')
    // trace id is derived from the run, so a trace export and this row agree
    assert.match(String(row.trace_id), /^[0-9a-f]{32}$/)
  })

  it('refuses to rewrite history: UPDATE and DELETE both fail', async () => {
    const ctx = ctxFor()
    await recordToolInvocation(ctx, { tool: 'repo_read', ok: true, argsExcerpt: '{"path":"README.md"}' })
    await assert.rejects(
      () => query(`UPDATE agent_audit_events SET status='succeeded' WHERE correlation_id = $1`, [ctx.correlationId]),
      /append-only/i
    )
    await assert.rejects(
      () => query(`DELETE FROM agent_audit_events WHERE correlation_id = $1`, [ctx.correlationId]),
      /append-only/i
    )
    const rows = await readAuditEvents({ correlationId: ctx.correlationId })
    assert.equal(rows.length, 1, 'the row survived both attempts')
  })

  it('scrubs credential shapes out of stored excerpts', async () => {
    const ctx = ctxFor()
    await recordToolInvocation(ctx, {
      tool: 'http_fetch',
      ok: true,
      argsExcerpt: 'authorization: Bearer abcdef1234567890xyz, key sk-thirdeye-abcdef123456',
      resultExcerpt: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAABCDEFGHIJKLMNOP',
      metadata: { api_key: 'sk-proj-should-not-appear', password: 'hunter2', nested: { token: 'nope' } },
    })
    const [row]: any[] = await readAuditEvents({ correlationId: ctx.correlationId })
    const serialised = JSON.stringify(row)
    for (const secret of ['sk-thirdeye-abcdef123456', 'abcdef1234567890xyz', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', 'sk-proj-should-not-appear', 'hunter2', 'nope']) {
      assert.equal(serialised.includes(secret), false, `leaked: ${secret}`)
    }
    assert.equal(row.metadata.api_key, '[redacted]')
    assert.equal(row.metadata.password, '[redacted]')
    assert.equal(row.metadata.nested.token, '[redacted]')
  })

  it('scrubs a private key block and bounds string length', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
    assert.equal(scrubAuditText(`before ${pem} after`).includes('MIIEow'), false)
    assert.equal(scrubAuditText('x'.repeat(2000), 50).length, 50)
    assert.deepEqual(redactForAudit([{ secret: 'a' }, 'sk-abcdefgh12345678']), [{ secret: '[redacted]' }, 'sk-***'])
  })

  it('fails closed on a critical event and stays quiet on a routine one', async () => {
    const failing = async () => { throw new Error('database is down') }
    const ctx = ctxFor()

    assert.equal(isCriticalEvent('task.delegated'), true)
    assert.equal(isCriticalEvent('tool.invoked'), false)
    for (const type of CRITICAL_EVENT_TYPES) {
      await assert.rejects(
        () => createAuditEvent({ ...ctx, eventType: type }, { writer: failing }),
        (e: any) => e instanceof AuditUnavailableError && e.code === 'audit_unavailable' && e.eventType === type
      )
    }

    // A routine event is recorded best effort: a note about a tool call is not worth failing
    // paid work over, so the write failure is absorbed and nothing is thrown.
    const routine = await createAuditEvent({ ...ctx, eventType: 'tool.invoked' }, { writer: failing })
    assert.equal(routine, null)
  })

  it('rejects an unknown event type instead of storing junk', async () => {
    await assert.rejects(
      () => createAuditEvent({ ...ctxFor(), eventType: 'run.teleported' as any }),
      /Unknown audit event type/
    )
  })

  it('records a denial as tool.denied with the reason kept', async () => {
    const ctx = ctxFor()
    await recordToolInvocation(ctx, {
      tool: 'repo_write',
      ok: false,
      refused: true,
      argsExcerpt: '{"files":[]}',
      metadata: { denial_reason: 'repo_write requires write authority' },
    })
    const [row]: any[] = await readAuditEvents({ correlationId: ctx.correlationId })
    assert.equal(row.event_type, 'tool.denied')
    assert.equal(row.status, 'denied')
    assert.match(String(row.metadata.denial_reason), /write authority/)
  })

  it('supports the stage, artifact and authorization recorders', async () => {
    const ctx = ctxFor()
    await recordStageTransition(ctx, { stageId: 'VALIDATED', eventType: 'stage.started' })
    await recordStageTransition(ctx, { stageId: 'PLANNED', eventType: 'stage.skipped', reason: 'no plan needed' })
    await recordArtifactEvent(ctx, { action: 'created', artifactId: 'artifact_9', version: 2 })
    await recordAuthorizationDecision(ctx, { allowed: false, tool: 'repo_write', reason: 'withheld' })
    await recordRunCompleted(ctx, { toolCalls: 3, spendMicros: 12 })

    const rows = await readAuditEvents({ correlationId: ctx.correlationId })
    assert.deepEqual(
      rows.map((r) => r.event_type),
      ['stage.started', 'stage.skipped', 'artifact.created', 'tool.denied', 'run.completed']
    )
    const skipped = rows.find((r) => r.event_type === 'stage.skipped')!
    assert.equal(skipped.status, 'skipped')
    assert.equal((skipped.metadata as any).reason, 'no plan needed')
    assert.deepEqual(rows.find((r) => r.event_type === 'artifact.created')!.artifact_ids, ['artifact_9'])
    assert.equal((rows.find((r) => r.event_type === 'run.completed')!.metadata as any).spend_usd_micros, 12)
  })

  it('keeps every declared event type reachable through the taxonomy', () => {
    assert.equal(AUDIT_EVENT_TYPES.length, 22)
    assert.equal(new Set(AUDIT_EVENT_TYPES).size, 22)
    for (const t of ['run.created', 'run.cancelled', 'task.accepted', 'artifact.read', 'permission.changed', 'approval.rejected']) {
      assert.ok(AUDIT_EVENT_TYPES.includes(t as any), `${t} missing`)
    }
  })

  /**
   * Restart durability, proved rather than assumed: one process writes an event and exits, a
   * second process (fresh module state, fresh connection) reads it back from the same data dir.
   */
  it('keeps events queryable after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-restart-'))
    const probe = spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/audit-restart-probe.ts', 'write', dir], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PGLITE_DIR: dir, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' },
    })
    assert.equal(probe.status, 0, `write process failed: ${probe.stderr || probe.stdout}`)

    const read = spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/audit-restart-probe.ts', 'read', dir], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PGLITE_DIR: dir, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' },
    })
    assert.equal(read.status, 0, `read process failed: ${read.stderr || read.stdout}`)
    assert.match(read.stdout, /RESTART_OK corr_persisted \d+/)
  })
})
