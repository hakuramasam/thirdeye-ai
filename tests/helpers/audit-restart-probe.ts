/**
 * Two-process durability probe for the audit table (PH2-001).
 *
 * `write` inserts one event and exits; `read` starts with completely fresh module state and a new
 * connection to the same PGlite data directory, then looks the event up by correlation id. If the
 * audit trail only lived in process memory this second step would find nothing.
 */
export {}

process.env.PGLITE_DIR = process.argv[3] || process.env.PGLITE_DIR
process.env.DATABASE_URL = ''

const phase = process.argv[2]
const { migrate, query } = await import('../../src/db/index.js')
const { createAuditEvent, readAuditEvents } = await import('../../src/agents/audit-log.js')

await migrate()

const CORRELATION = 'corr_persisted'

if (phase === 'write') {
  await createAuditEvent({
    correlationId: CORRELATION,
    runId: 'run_persisted',
    agentId: 'tdt_qa',
    agentRole: 'QA',
    eventType: 'run.completed',
    status: 'succeeded',
    metadata: { note: 'written by the first process' },
  })
  console.log('WROTE', CORRELATION)
  process.exit(0)
} else {
  const rows = await readAuditEvents({ correlationId: CORRELATION })
  if (rows.length !== 1) {
    console.error(`expected one row after restart, found ${rows.length}`)
    process.exit(1)
  }
  const r: any = rows[0]
  if (r.run_id !== 'run_persisted' || r.metadata?.note !== 'written by the first process') {
    console.error('row did not survive intact', r)
    process.exit(1)
  }
  const count = await query(`SELECT count(*)::int AS c FROM agent_audit_events`)
  console.log(`RESTART_OK ${CORRELATION} ${(count.rows[0] as any).c}`)
  // PGlite keeps a worker alive, so exit explicitly rather than waiting on the loop to drain.
  process.exit(0)
}
