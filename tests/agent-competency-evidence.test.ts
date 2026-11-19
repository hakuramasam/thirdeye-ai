process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL
delete process.env.DATABASE_URL_UNPOOLED
process.env.CRON_SECRET = 'competency-test-secret'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'

const { Hono } = await import('hono')
const { migrate, query } = await import('../src/db/index.js')
const { registerCronRoute } = await import('../src/routes/agents.js')

test('competency evidence endpoint requires cron auth and returns redacted inspectable evidence', async () => {
  await migrate()
  const userId = randomUUID()
  const wallet = '0x' + randomUUID().replace(/-/g, '').slice(0, 40)
  await query('INSERT INTO users (id,wallet,role) VALUES ($1,$2,$3)', [userId, wallet, 'user'])
  const agentId = 'evidence-agent-' + randomUUID()
  await query(
    `INSERT INTO agents (id,user_id,name,system_prompt,model,mcp_servers,x402_enabled,budget_usd_micros,max_steps)
     VALUES ($1,$2,'QA','test','thirdeye-mock','[]',false,100000,2)`, [agentId,userId]
  )
  const runId = randomUUID()
  await query(
    `INSERT INTO agent_runs (id,agent_id,user_id,status,input,output,tool_calls,spend_usd_micros,skill_version,skill_sha256)
     VALUES ($1,$2,$3,'success','test','ok',1,0,'2.0.0',repeat('a',64))`, [runId,agentId,userId]
  )
  await query(
    `INSERT INTO agent_run_events (id,run_id,agent_id,seq,tool,ok,refused,args_excerpt,result_excerpt)
     VALUES ($1,$2,$3,1,'repo_read',true,false,'SECRET_ARGUMENT','SECRET_RESULT')`, [randomUUID(),runId,agentId]
  )
  await query(
    `INSERT INTO agent_audit_events (id,event_id,correlation_id,run_id,agent_id,agent_role,event_type,status)
     VALUES ($1,$2,$3,$4,$5,'QA','run.completed','succeeded')`, [randomUUID(),randomUUID(),randomUUID(),runId,agentId]
  )
  const app = new Hono()
  registerCronRoute(app as any)
  const denied = await app.request('/api/cron/agents/evidence/' + runId)
  assert.equal(denied.status, 401)
  const response = await app.request('/api/cron/agents/evidence/' + runId, { headers: { authorization: 'Bearer competency-test-secret' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.run.skill_version, '2.0.0')
  assert.equal(body.tool_events.length, 1)
  assert.equal(body.audit_events.length, 1)
  const serialized = JSON.stringify(body)
  assert.ok(!serialized.includes('SECRET_ARGUMENT'))
  assert.ok(!serialized.includes('SECRET_RESULT'))
})
