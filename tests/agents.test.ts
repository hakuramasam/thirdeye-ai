process.env.PGLITE_DIR = 'memory://'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { z } from 'zod'

const { migrate, query, one } = await import('../src/db/index.js')
const { createSessionToken } = await import('../src/lib/session.js')
const { isCronDue, parseCron } = await import('../src/agents/cron.js')
const { createMcpTools } = await import('../src/agents/mcp.js')
const { runAgent } = await import('../src/agents/runner.js')
const { registerAgentsRoutes, registerCronRoute } = await import('../src/routes/agents.js')
import type { AppEnv } from '../src/lib/types.js'
import type { AgentRow } from '../src/agents/runner.js'

let server: any
let mcpUrl = ''

describe('Agents Module C Tests', () => {
  let testUser: any
  let token = ''

  before(async () => {
    await migrate()
    // In-process MCP HTTP server (streamable HTTP, stateless)
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { WebStandardStreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
    )
    const makeMcpServer = () => {
      const mcp = new McpServer({ name: 'test-weather', version: '1.0.0' })
      mcp.registerTool(
        'weather',
        { description: 'Get the current weather for a city', inputSchema: { city: z.string().describe('City name') } },
        async ({ city }) => ({ content: [{ type: 'text', text: JSON.stringify({ city, temp_c: 30, condition: 'sunny' }) }] })
      )
      return mcp
    }
    // Stateless: a fresh transport per request (SDK requirement in stateless mode)
    const mcpApp = new Hono()
    mcpApp.all('/mcp', async (c) => {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await makeMcpServer().connect(transport)
      return transport.handleRequest(c.req.raw)
    })
    server = serve({ fetch: mcpApp.fetch, port: 0 })
    const addr = server.address()
    mcpUrl = `http://127.0.0.1:${addr.port}/mcp`

    // User
    const { randomUUID } = await import('node:crypto')
    testUser = { id: randomUUID(), wallet: '0x3333333333333333333333333333333333333333', role: 'user', created_at: new Date().toISOString() }
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      testUser.id, testUser.wallet, testUser.role,
    ])
    token = await createSessionToken(testUser)
  })

  it('(a) cron unit tests', () => {
    // every minute
    assert.equal(isCronDue('* * * * *', new Date('2026-10-01T10:07:00Z'), null), true)
    assert.equal(isCronDue('* * * * *', new Date('2026-10-01T10:07:30Z'), new Date('2026-10-01T10:07:10Z')), false)
    assert.equal(isCronDue('* * * * *', new Date('2026-10-01T10:07:00Z'), new Date('2026-10-01T10:06:59Z')), true)
    // hourly at :30
    assert.equal(isCronDue('30 * * * *', new Date('2026-10-01T10:30:00Z'), null), true)
    assert.equal(isCronDue('30 * * * *', new Date('2026-10-01T10:31:00Z'), null), false)
    // lists + steps
    assert.equal(isCronDue('*/15 * * * *', new Date('2026-10-01T10:45:00Z'), null), true)
    assert.equal(isCronDue('*/15 * * * *', new Date('2026-10-01T10:50:00Z'), null), false)
    assert.equal(isCronDue('0 9 * * 1', new Date('2026-09-28T09:00:00Z'), null), true) // a Monday
    assert.equal(isCronDue('0 9 * * 1', new Date('2026-09-29T09:00:00Z'), null), false)
    // invalid
    assert.throws(() => parseCron('not a cron'))
    assert.throws(() => parseCron('61 * * * *'))
  })

  it('(b) runAgent with real MCP server + injected fake llm', async () => {
    const mcpTools = await createMcpTools([{ name: 'test', url: mcpUrl }])
    assert.equal(mcpTools.errors.length, 0)
    const weatherTool = mcpTools.tools.find((t) => t.function.name === 'mcp_test_weather')
    assert.ok(weatherTool, 'weather tool listed with namespace')

    const calls: any[] = []
    let n = 0
    const fakeLlm = {
      async call(params: any) {
        calls.push(params)
        n++
        if (n === 1) {
          return {
            content: '',
            prompt_tokens: 10,
            completion_tokens: 5,
            tool_calls: [{
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'mcp_test_weather', arguments: '{"city":"Yangon"}' },
            }],
          }
        }
        return { content: 'It is 30°C and sunny in Yangon.', prompt_tokens: 40, completion_tokens: 12 }
      },
    }

    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, mcp_servers, x402_enabled, budget_usd_micros, max_steps)
       VALUES ('agt_test_1', $1, 'weather-agent', 'You report weather.', 'haku-mock', '[]', false, 100000, 4)
       ON CONFLICT DO NOTHING`,
      [testUser.id]
    )
    const agent: AgentRow = {
      id: 'agt_test_1',
      user_id: testUser.id,
      name: 'weather-agent',
      system_prompt: 'You report weather.',
      model: 'haku-mock',
      mcp_servers: JSON.stringify([{ name: 'test', url: mcpUrl }]),
      x402_enabled: false,
      budget_usd_micros: 100000,
      max_steps: 4,
      cron: null,
      last_run_at: null,
      status: 'active',
      created_at: new Date().toISOString(),
    }
    const res = await runAgent(agent, 'What is the weather in Yangon?', testUser, { llm: fakeLlm, mcpTools })
    assert.equal(res.status, 'success')
    assert.match(res.output!, /30/)
    assert.equal(res.tool_calls, 1)
    // tool result was fed back to the model
    const toolMsg = calls[1].messages.find((m: any) => m.role === 'tool')
    assert.ok(toolMsg && toolMsg.content.includes('temp_c'), 'weather result passed as tool message')
    await mcpTools.close()
  })

  it('(b2) runAgent persists agent_runs row', async () => {
    const { randomUUID } = await import('node:crypto')
    const agentId = randomUUID()
    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, mcp_servers, x402_enabled, budget_usd_micros, max_steps)
       VALUES ($1,$2,'persist-agent','sys','haku-mock','[]',false,100000,4)`,
      [agentId, testUser.id]
    )
    const agent = await one(`SELECT * FROM agents WHERE id = $1`, [agentId])
    const fakeLlm = { async call() { return { content: 'done', prompt_tokens: 1, completion_tokens: 1 } } }
    const res = await runAgent(agent, 'hi', testUser, { llm: fakeLlm })
    assert.equal(res.status, 'success')
    const run = await one(`SELECT * FROM agent_runs WHERE id = $1`, [res.runId])
    assert.equal(run.status, 'success')
    assert.equal(run.output, 'done')
    const updated = await one(`SELECT last_run_at FROM agents WHERE id = $1`, [agentId])
    assert.ok(updated.last_run_at, 'last_run_at set')
  })

  it('(c) routes: CRUD, ownership, run, cron trigger', async () => {
    const app = new Hono<AppEnv>()
    registerAgentsRoutes(app)
    registerCronRoute(app)
    const H = { 'x-session-token': token, 'content-type': 'application/json' }

    // create agent with valid model from seeded catalog
    const created = await app.request('/api/agents', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'ci-agent', system_prompt: 'Be terse.', model: 'haku-mock', mcp_servers: [{ name: 'test', url: mcpUrl }] }),
    })
    assert.equal(created.status, 201)
    const agent = (await created.json()).agent
    assert.equal(agent.mcp_servers.length, 1)

    // invalid model rejected
    const bad = await app.request('/api/agents', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'x', system_prompt: 's', model: 'nope-model' }),
    })
    assert.equal(bad.status, 400)

    // invalid cron rejected
    const badCron = await app.request('/api/agents', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'x', system_prompt: 's', model: 'haku-mock', cron: 'every tuesday' }),
    })
    assert.equal(badCron.status, 400)

    // ownership: second user cannot see/patch/delete
    const { randomUUID } = await import('node:crypto')
    const otherId = randomUUID()
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, '0x4444444444444444444444444444444444444444', 'user') ON CONFLICT DO NOTHING`, [otherId])
    const other = { id: otherId, wallet: '0x4444444444444444444444444444444444444444', role: 'user', created_at: '' }
    const otherToken = await createSessionToken(other)
    const foreign = await app.request(`/api/agents/${agent.id}`, { headers: { 'x-session-token': otherToken } })
    assert.equal(foreign.status, 404)

    // patch
    const patched = await app.request(`/api/agents/${agent.id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ system_prompt: 'Be very terse.' }),
    })
    assert.equal(patched.status, 200)
    assert.equal((await patched.json()).agent.system_prompt, 'Be very terse.')

    // run now (mock provider, no upstream key needed) -> mock needs catalog row + provider; haku-mock is free
    const run = await app.request(`/api/agents/${agent.id}/run`, {
      method: 'POST', headers: H, body: JSON.stringify({ input: 'Say hello' }),
    })
    assert.ok([200, 422].includes(run.status))
    const runBody = await run.json()
    assert.ok(runBody.runId)

    // run history
    const runs = await app.request(`/api/agents/${agent.id}/runs`, { headers: H })
    assert.equal(runs.status, 200)
    assert.ok((await runs.json()).runs.length >= 1)

    // delete (soft)
    const del = await app.request(`/api/agents/${agent.id}`, { method: 'DELETE', headers: H })
    assert.equal(del.status, 200)
    const gone = await app.request(`/api/agents/${agent.id}`, { headers: H })
    assert.equal(gone.status, 404)

    // cron trigger: 401 without secret
    const unauth = await app.request('/api/cron/agents', { method: 'POST' })
    assert.equal(unauth.status, 401)
    // with secret, agent list empty/non-due -> triggered []
    process.env.CRON_SECRET = 'test-cron-secret'
    const { env: envMod } = await import('../src/lib/env.js')
    envMod.cronSecret = 'test-cron-secret'
    const cronRes = await app.request('/api/cron/agents', {
      method: 'POST', headers: { authorization: 'Bearer test-cron-secret' },
    })
    assert.equal(cronRes.status, 200)
    const cronBody = await cronRes.json()
    assert.ok(Array.isArray(cronBody.triggered))
    envMod.cronSecret = ''
    process.env.CRON_SECRET = ''
  })

  after(() => {
    server?.close()
  })
})
