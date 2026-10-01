/** Agent CRUD, manual run, run history, and the cron trigger endpoint. */

import { randomUUID } from 'node:crypto'
import { query, one } from '../db/index.js'
import { env } from '../lib/env.js'
import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { parseCron, isCronDue } from '../agents/cron.js'
import { runAgent, type AgentRow } from '../agents/runner.js'

type McpServerIn = { name?: string; url?: string; headers?: Record<string, string> }

const MAX_AGENTS = 20
const MAX_MCP_SERVERS = 5

function validMcpServers(v: unknown): { ok: boolean; servers?: any[]; error?: string } {
  if (!Array.isArray(v)) return { ok: false, error: 'mcp_servers must be an array' }
  if (v.length > MAX_MCP_SERVERS) return { ok: false, error: `At most ${MAX_MCP_SERVERS} MCP servers per agent` }
  const servers: any[] = []
  for (const s of v as McpServerIn[]) {
    if (!s || typeof s.name !== 'string' || !/^[a-zA-Z0-9_-]{1,24}$/.test(s.name)) {
      return { ok: false, error: 'MCP server name must be 1-24 chars (letters, digits, _, -)' }
    }
    if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) {
      return { ok: false, error: `MCP server '${s.name}': url must be http(s)` }
    }
    servers.push({ name: s.name, url: s.url, ...(s.headers && typeof s.headers === 'object' ? { headers: s.headers } : {}) })
  }
  return { ok: true, servers }
}

function rowOut(a: any) {
  return {
    id: a.id,
    name: a.name,
    system_prompt: a.system_prompt,
    model: a.model,
    mcp_servers: typeof a.mcp_servers === 'string' ? JSON.parse(a.mcp_servers || '[]') : a.mcp_servers || [],
    x402_enabled: a.x402_enabled,
    budget_usd_micros: Number(a.budget_usd_micros),
    max_steps: a.max_steps,
    cron: a.cron,
    last_run_at: a.last_run_at,
    status: a.status,
    created_at: a.created_at,
  }
}

async function loadOwned(id: string | undefined, userId: string): Promise<AgentRow | null> {
  return one(`SELECT * FROM agents WHERE id = $1 AND user_id = $2 AND status != 'deleted'`, [id, userId])
}

export function registerAgentsRoutes(app: SessionApp): void {
  // GET /api/agents — list
  app.get('/api/agents', requireUser, async (c) => {
    const user = c.get('user')!
    const res = await query(
      `SELECT * FROM agents WHERE user_id = $1 AND status != 'deleted' ORDER BY created_at DESC`,
      [user.id]
    )
    return c.json({ agents: res.rows.map(rowOut) })
  })

  // POST /api/agents — create
  app.post('/api/agents', requireUser, async (c) => {
    const user = c.get('user')!
    const body = await c.req.json().catch(() => null)
    if (!body) return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request', code: 400 } }, 400)
    const { name, system_prompt, model, mcp_servers = [], x402_enabled = false, budget_usd_micros = 100000, max_steps = 8, cron = null } = body

    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 64) {
      return c.json({ error: { message: 'name must be 1-64 characters', type: 'invalid_request', code: 400 } }, 400)
    }
    if (typeof system_prompt !== 'string' || system_prompt.length < 1 || system_prompt.length > 8000) {
      return c.json({ error: { message: 'system_prompt must be 1-8000 characters', type: 'invalid_request', code: 400 } }, 400)
    }
    if (typeof model !== 'string' || model.length < 1 || model.length > 100) {
      return c.json({ error: { message: 'model is required', type: 'invalid_request', code: 400 } }, 400)
    }
    const modelRow = await one(`SELECT model FROM models_catalog WHERE model = $1 AND enabled`, [model])
    if (!modelRow) {
      return c.json({ error: { message: `Unknown or disabled model: ${model}`, type: 'invalid_request', code: 400 } }, 400)
    }
    const mcp = validMcpServers(mcp_servers)
    if (!mcp.ok) return c.json({ error: { message: mcp.error!, type: 'invalid_request', code: 400 } }, 400)
    const budget = Number(budget_usd_micros)
    if (!Number.isInteger(budget) || budget < 1 || budget > 10_000_000) {
      return c.json({ error: { message: 'budget_usd_micros must be an integer between 1 and 10,000,000 ($10)', type: 'invalid_request', code: 400 } }, 400)
    }
    const steps = Number(max_steps)
    if (!Number.isInteger(steps) || steps < 1 || steps > 20) {
      return c.json({ error: { message: 'max_steps must be 1-20', type: 'invalid_request', code: 400 } }, 400)
    }
    if (cron != null) {
      if (typeof cron !== 'string') return c.json({ error: { message: 'cron must be a 5-field string', type: 'invalid_request', code: 400 } }, 400)
      try { parseCron(cron) } catch (e: any) {
        return c.json({ error: { message: `Invalid cron: ${e.message}`, type: 'invalid_request', code: 400 } }, 400)
      }
    }

    const count = await one(`SELECT count(*)::int AS n FROM agents WHERE user_id = $1 AND status != 'deleted'`, [user.id])
    if (count.n >= MAX_AGENTS) {
      return c.json({ error: { message: `Agent limit reached (${MAX_AGENTS})`, type: 'invalid_request', code: 400 } }, 400)
    }

    const id = randomUUID()
    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, mcp_servers, x402_enabled, budget_usd_micros, max_steps, cron)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, user.id, name.trim(), system_prompt, model, JSON.stringify(mcp.servers), !!x402_enabled, budget, steps, cron]
    )
    const row = await one(`SELECT * FROM agents WHERE id = $1`, [id])
    return c.json({ agent: rowOut(row) }, 201)
  })

  // GET /api/agents/:id
  app.get('/api/agents/:id', requireUser, async (c) => {
    const user = c.get('user')!
    const row = await loadOwned(c.req.param('id'), user.id)
    if (!row) return c.json({ error: { message: 'Agent not found', type: 'not_found', code: 404 } }, 404)
    return c.json({ agent: rowOut(row) })
  })

  // PATCH /api/agents/:id
  app.patch('/api/agents/:id', requireUser, async (c) => {
    const user = c.get('user')!
    const row = await loadOwned(c.req.param('id'), user.id)
    if (!row) return c.json({ error: { message: 'Agent not found', type: 'not_found', code: 404 } }, 404)
    const body = await c.req.json().catch(() => ({}))
    const sets: string[] = []
    const vals: any[] = []
    const add = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
    if (body.system_prompt !== undefined) {
      if (typeof body.system_prompt !== 'string' || body.system_prompt.length < 1 || body.system_prompt.length > 8000) {
        return c.json({ error: { message: 'system_prompt must be 1-8000 characters', type: 'invalid_request', code: 400 } }, 400)
      }
      add('system_prompt', body.system_prompt)
    }
    if (body.model !== undefined) {
      const m = await one(`SELECT model FROM models_catalog WHERE model = $1 AND enabled`, [body.model])
      if (!m) return c.json({ error: { message: `Unknown or disabled model: ${body.model}`, type: 'invalid_request', code: 400 } }, 400)
      add('model', body.model)
    }
    if (body.mcp_servers !== undefined) {
      const mcp = validMcpServers(body.mcp_servers)
      if (!mcp.ok) return c.json({ error: { message: mcp.error!, type: 'invalid_request', code: 400 } }, 400)
      add('mcp_servers', JSON.stringify(mcp.servers))
    }
    if (body.x402_enabled !== undefined) add('x402_enabled', !!body.x402_enabled)
    if (body.budget_usd_micros !== undefined) {
      const b = Number(body.budget_usd_micros)
      if (!Number.isInteger(b) || b < 1 || b > 10_000_000) {
        return c.json({ error: { message: 'budget_usd_micros must be an integer between 1 and 10,000,000', type: 'invalid_request', code: 400 } }, 400)
      }
      add('budget_usd_micros', b)
    }
    if (body.max_steps !== undefined) {
      const s = Number(body.max_steps)
      if (!Number.isInteger(s) || s < 1 || s > 20) {
        return c.json({ error: { message: 'max_steps must be 1-20', type: 'invalid_request', code: 400 } }, 400)
      }
      add('max_steps', s)
    }
    if (body.cron !== undefined) {
      if (body.cron !== null) {
        if (typeof body.cron !== 'string') return c.json({ error: { message: 'cron must be a string or null', type: 'invalid_request', code: 400 } }, 400)
        try { parseCron(body.cron) } catch (e: any) {
          return c.json({ error: { message: `Invalid cron: ${e.message}`, type: 'invalid_request', code: 400 } }, 400)
        }
      }
      add('cron', body.cron)
    }
    if (body.status === 'paused' || body.status === 'active') add('status', body.status)

    if (sets.length === 0) return c.json({ error: { message: 'Nothing to update', type: 'invalid_request', code: 400 } }, 400)
    vals.push(row.id)
    const updated = await one(`UPDATE agents SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)
    return c.json({ agent: rowOut(updated) })
  })

  // DELETE /api/agents/:id (soft)
  app.delete('/api/agents/:id', requireUser, async (c) => {
    const user = c.get('user')!
    const row = await loadOwned(c.req.param('id'), user.id)
    if (!row) return c.json({ error: { message: 'Agent not found', type: 'not_found', code: 404 } }, 404)
    await query(`UPDATE agents SET status = 'deleted' WHERE id = $1`, [row.id])
    return c.json({ ok: true })
  })

  // POST /api/agents/:id/run — run now
  app.post('/api/agents/:id/run', requireUser, async (c) => {
    const user = c.get('user')!
    const row = await loadOwned(c.req.param('id'), user.id)
    if (!row) return c.json({ error: { message: 'Agent not found', type: 'not_found', code: 404 } }, 404)
    const body = await c.req.json().catch(() => null)
    const input = body?.input
    if (typeof input !== 'string' || input.length < 1 || input.length > 16000) {
      return c.json({ error: { message: 'input must be 1-16000 characters', type: 'invalid_request', code: 400 } }, 400)
    }
    const result = await runAgent(row, input, user)
    return c.json(result, result.status === 'success' ? 200 : 422)
  })

  // GET /api/agents/:id/runs — run history
  app.get('/api/agents/:id/runs', requireUser, async (c) => {
    const user = c.get('user')!
    const row = await loadOwned(c.req.param('id'), user.id)
    if (!row) return c.json({ error: { message: 'Agent not found', type: 'not_found', code: 404 } }, 404)
    const res = await query(
      `SELECT id, status, input, output, tool_calls, spend_usd_micros, error, created_at
       FROM agent_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [row.id]
    )
    return c.json({ runs: res.rows })
  })
}

/**
 * POST /api/cron/agents — Vercel cron / external pinger entry.
 * No session: guarded by Bearer CRON_SECRET. Runs every active, cron-set agent
 * that is due, sequentially, capped at 20 per invocation.
 */
export function registerCronRoute(app: SessionApp): void {
  app.post('/api/cron/agents', async (c) => {
    const auth = c.req.header('authorization') || ''
    if (!env.cronSecret || auth !== `Bearer ${env.cronSecret}`) {
      return c.json({ error: { message: 'Unauthorized', type: 'auth', code: 401 } }, 401)
    }
    const res = await query(
      `SELECT * FROM agents WHERE status = 'active' AND cron IS NOT NULL ORDER BY last_run_at ASC NULLS FIRST LIMIT 20`
    )
    const triggered: string[] = []
    const results: any[] = []
    const now = new Date()
    for (const row of res.rows as AgentRow[]) {
      let due = false
      try { due = isCronDue(row.cron!, now, row.last_run_at ? new Date(row.last_run_at) : null) } catch { due = false }
      if (!due) continue
      triggered.push(row.id)
      try {
        const user = await one(`SELECT * FROM users WHERE id = $1`, [row.user_id])
        if (user) {
          const r = await runAgent(row, `Scheduled run at ${now.toISOString()}`, user)
          results.push({ agent_id: row.id, ...r })
        }
      } catch (e: any) {
        results.push({ agent_id: row.id, status: 'error', error: String(e?.message || e).slice(0, 300) })
      }
    }
    return c.json({ triggered, results })
  })
}
