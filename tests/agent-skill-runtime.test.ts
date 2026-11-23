process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL
delete process.env.DATABASE_URL_UNPOOLED

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'

const { migrate, query, one } = await import('../src/db/index.js')
const { loadRoleSkillPack } = await import('../src/agents/skill-packs.js')
const { runAgent } = await import('../src/agents/runner.js')

test('role skill resolver maps all twelve team roles and ignores ordinary agents', () => {
  const roles = [
    ['tdt_hermes', 'HERMES', 'hermes'], ['tdt_product', 'Product & Research', 'product'],
    ['tdt_architect', 'System Architect', 'architect'], ['tdt_backend', 'Backend Engineer', 'backend'],
    ['tdt_frontend', 'Frontend Engineer', 'frontend'], ['tdt_blockchain', 'Wallet & Finance Specialist', 'blockchain'],
    ['tdt_intelligence', 'Data Intelligence Specialist', 'intelligence'], ['tdt_agent-engineer', 'Agent Runtime Engineer', 'agent-engineer'],
    ['tdt_qa', 'QA & Testing', 'qa'], ['tdt_sentinel', 'Security Sentinel', 'sentinel'],
    ['tdt_devops', 'DevOps & Release', 'devops'], ['tdt_docs', 'Documentation', 'docs'],
  ] as const
  for (const [id, name, role] of roles) {
    const pack = loadRoleSkillPack(id, name)
    assert.ok(pack, `${id} should resolve a role pack`)
    assert.equal(pack.role, role)
    assert.equal(pack.version, '2.0.0')
    assert.match(pack.sha256, /^[a-f0-9]{64}$/)
    assert.match(pack.content, /Capability contract/)
  }
  assert.equal(loadRoleSkillPack('user-agent-123', 'My Personal Assistant'), null)
})

test('runtime injects the role pack and persists exact skill provenance per run', async () => {
  await migrate()
  const userId = randomUUID()
  const wallet = '0x' + randomUUID().replace(/-/g, '').slice(0, 40)
  await query('INSERT INTO users (id, wallet, role) VALUES ($1,$2,$3)', [userId, wallet, 'user'])
  await query(
    `INSERT INTO agents (id,user_id,name,system_prompt,model,mcp_servers,x402_enabled,budget_usd_micros,max_steps)
     VALUES ('tdt_hermes',$1,'HERMES','Base operator prompt.','thirdeye-mock','[]',false,100000,2)`,
    [userId]
  )
  const agent = await one('SELECT * FROM agents WHERE id=$1', ['tdt_hermes'])
  const seen: any[] = []
  const fakeLlm = { async call(params: any) { seen.push(params); return { content: 'Completed with evidence.', prompt_tokens: 2, completion_tokens: 2 } } }
  const result = await runAgent(agent, 'Perform a bounded competency check.', { id: userId, wallet, role: 'user', created_at: new Date().toISOString() } as any, { llm: fakeLlm })
  assert.equal(result.status, 'success')
  assert.equal(result.skill_version, '2.0.0')
  assert.match(result.skill_sha256 ?? '', /^[a-f0-9]{64}$/)
  const system = seen[0].messages.find((m: any) => m.role === 'system')?.content ?? ''
  assert.match(system, /Base operator prompt\./)
  assert.match(system, /REVIEWED ROLE SKILL PACK: hermes v2\.0\.0/)
  const run = await one('SELECT skill_version, skill_sha256 FROM agent_runs WHERE id=$1', [result.runId])
  assert.equal(run.skill_version, result.skill_version)
  assert.equal(run.skill_sha256, result.skill_sha256)
})

test('skill-pack emergency rollback switch restores the original system prompt only', () => {
  const original = process.env.THIRDEYE_AGENT_SKILLS_ENABLED
  process.env.THIRDEYE_AGENT_SKILLS_ENABLED = 'false'
  try { assert.equal(loadRoleSkillPack('tdt_hermes', 'HERMES'), null) }
  finally { if (original === undefined) delete process.env.THIRDEYE_AGENT_SKILLS_ENABLED; else process.env.THIRDEYE_AGENT_SKILLS_ENABLED = original }
})
