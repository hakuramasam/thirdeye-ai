import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuditEvent } from '../src/agents/audit-log.js'

test('audit events preserve the trusted initiating actor and redact its context', async () => {
  let written: Record<string, unknown> | null = null
  await createAuditEvent({
    correlationId: 'corr_test',
    runId: 'run_test',
    eventType: 'run.started',
    actorType: 'user',
    authorizationContext: {
      invoker_id: 'user_123',
      invocation_source: 'api.manual_agent_run',
      authorization: 'Bearer should-not-be-stored',
    },
  }, { writer: async (row) => { written = row } })

  assert.equal(written?.actor_type, 'user')
  assert.deepEqual(written?.authorization_context, {
    invoker_id: 'user_123',
    invocation_source: 'api.manual_agent_run',
    authorization: '[redacted]',
  })
})
