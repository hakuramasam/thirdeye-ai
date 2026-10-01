/**
 * Autonomous agent runner: LLM loop with MCP tools, optional x402-paid
 * http_fetch, per-step billing against the user ledger, per-run budget.
 */

import { randomUUID } from 'node:crypto'
import { query, one } from '../db/index.js'
import { env } from '../lib/env.js'
import { debitForUsage } from '../lib/billing.js'
import { computeCostMicros } from '../lib/pricing.js'
import { getModelRow, type ProviderCall } from '../providers/index.js'
import { createMcpTools, type McpTools, type McpServerConfig } from './mcp.js'
import { paidFetch } from './x402.js'
import type { ModelRow } from '../lib/pricing.js'
import type { UserRow } from '../lib/types.js'

export type AgentRow = {
  id: string
  user_id: string
  name: string
  system_prompt: string
  model: string
  mcp_servers: McpServerConfig[] | string
  x402_enabled: boolean
  budget_usd_micros: number | string
  max_steps: number
  cron: string | null
  last_run_at: string | null
  status: string
  created_at: string
}

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type LlmResult = {
  content: string
  prompt_tokens: number
  completion_tokens: number
  tool_calls?: ToolCall[]
}

export type RunnerDeps = {
  /** Injectable for tests; default resolves via the provider layer. */
  llm?: { call(params: Record<string, any>): Promise<LlmResult> }
  mcpTools?: McpTools
}

export type RunResult = {
  runId: string
  status: 'success' | 'error'
  output: string | null
  tool_calls: number
  spend_usd_micros: number
  error: string | null
}

const MAX_TOOL_RESULT_CHARS = 4000

function asMcpServers(v: McpServerConfig[] | string): McpServerConfig[] {
  if (Array.isArray(v)) return v
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : [] } catch { return [] }
}

/** Built-in http_fetch tool when the agent has x402 enabled. */
const HTTP_FETCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'http_fetch',
    description:
      'Fetch an HTTP URL and return the body (truncated). If the endpoint requires x402 payment, it is paid automatically from the agent wallet within the call budget.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to fetch' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        body: { type: 'string', description: 'Request body for POST' },
      },
      required: ['url'],
    },
  },
}

export async function runAgent(
  agent: AgentRow,
  input: string,
  user: UserRow,
  deps: RunnerDeps = {}
): Promise<RunResult> {
  const runId = randomUUID()
  const budget = Number(agent.budget_usd_micros)
  const maxSteps = Math.min(Math.max(agent.max_steps || 8, 1), 20)

  await query(
    `INSERT INTO agent_runs (id, agent_id, user_id, status, input) VALUES ($1, $2, $3, 'running', $4)`,
    [runId, agent.id, user.id, input]
  )

  const finish = async (
    status: 'success' | 'error',
    output: string | null,
    toolCalls: number,
    spend: number,
    error: string | null
  ): Promise<RunResult> => {
    await query(
      `UPDATE agent_runs SET status=$1, output=$2, tool_calls=$3, spend_usd_micros=$4, error=$5 WHERE id=$6`,
      [status, output, toolCalls, spend, error, runId]
    )
    await query(`UPDATE agents SET last_run_at = now() WHERE id = $1`, [agent.id])
    return { runId, status, output, tool_calls: toolCalls, spend_usd_micros: spend, error }
  }

  // Resolve model + LLM.
  let modelRow: ModelRow | null = null
  let llm = deps.llm
  if (!llm) {
    modelRow = await getModelRow(agent.model)
    if (!modelRow) return finish('error', null, 0, 0, `Model '${agent.model}' not found in catalog`)
    const { resolveProvider } = await import('../providers/index.js')
    const provider = await resolveProvider(user, modelRow)
    llm = provider
  }

  // Resolve MCP tools.
  const servers = asMcpServers(agent.mcp_servers)
  let mcpTools = deps.mcpTools ?? null
  let ownedMcp = false
  if (!deps.mcpTools && servers.length > 0) {
    mcpTools = await createMcpTools(servers)
    ownedMcp = true
  }

  const tools = [...(mcpTools?.tools ?? [])]
  if (agent.x402_enabled) tools.push(HTTP_FETCH_TOOL)

  try {
    const messages: any[] = [
      { role: 'system', content: agent.system_prompt },
      { role: 'user', content: input },
    ]
    const useTools = tools.length > 0
    let spend = 0
    let toolCalls = 0
    let byok = false
    try {
      const { resolveProvider } = await import('../providers/index.js')
      byok = modelRow ? (await resolveProvider(user, modelRow)).byok : false
    } catch { byok = false }

    for (let step = 0; step < maxSteps; step++) {
      const res = await llm!.call(useTools ? { messages, tools } : { messages })
      const cost =
        modelRow != null
          ? computeCostMicros(modelRow, res.prompt_tokens, res.completion_tokens, env.platformMarginPct, byok)
          : 0
      if (cost > 0) {
        const debit = await debitForUsage(user.id, cost, `agent:${runId}`)
        if (!debit.ok) {
          return await finish('error', null, toolCalls, spend, 'Insufficient credits')
        }
        spend += cost
        if (spend > budget) {
          return await finish('error', null, toolCalls, spend, 'Budget exceeded')
        }
      }

      if (res.tool_calls && res.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: res.tool_calls,
        })
        for (const tc of res.tool_calls) {
          let result = 'Tool unavailable'
          try {
            const args = JSON.parse(tc.function.arguments || '{}')
            if (tc.function.name === 'http_fetch' && agent.x402_enabled) {
              const r = await paidFetch(String(args.url), {
                method: args.method === 'POST' ? 'POST' : 'GET',
                headers: args.body ? { 'content-type': 'application/json' } : undefined,
                body: args.body,
              })
              const text = await r.response.text()
              result = `HTTP ${r.response.status}${r.paid ? ' (x402 paid)' : ''}: ${text.slice(0, MAX_TOOL_RESULT_CHARS)}`
            } else if (mcpTools) {
              result = (await mcpTools.call(tc.function.name, args)).slice(0, MAX_TOOL_RESULT_CHARS)
            } else {
              result = `Unknown tool: ${tc.function.name}`
            }
          } catch (e: any) {
            result = `Tool error: ${String(e?.message || e).slice(0, 300)}`
          }
          toolCalls++
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
        }
        continue
      }

      // Final answer.
      return await finish('success', res.content || '', toolCalls, spend, null)
    }
    return await finish('error', null, toolCalls, spend, `Max steps (${maxSteps}) reached without a final answer`)
  } finally {
    if (ownedMcp && mcpTools) await mcpTools.close().catch(() => {})
  }
}

export async function getAgent(id: string, userId: string): Promise<AgentRow | null> {
  return one(`SELECT * FROM agents WHERE id = $1 AND user_id = $2 AND status != 'deleted'`, [id, userId])
}
