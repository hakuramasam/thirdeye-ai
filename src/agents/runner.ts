/**
 * Autonomous agent runner: LLM loop with MCP tools, optional x402-paid
 * http_fetch, per-step billing against the user ledger, per-run budget.
 */

import { randomUUID } from 'node:crypto'
import { query, one } from '../db/index.js'
import { env } from '../lib/env.js'
import { debitForUsage } from '../lib/billing.js'
import { isCovered } from '../lib/allowance.js'
import { computeCostMicros } from '../lib/pricing.js'
import { getModelRow, type ProviderCall } from '../providers/index.js'
import { createMcpTools, type McpTools, type McpServerConfig } from './mcp.js'
import { validateTask } from '../team/validate.js'
import { emitAgentRunSpan, traceIdFrom, spanIdFrom } from '../telemetry/langfuse.js'
import { paidFetch } from './x402.js'
import { verifyPayment, txHashFrom } from '../lib/partnerVerify.js'
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
  x402_allowed_sellers?: string[] | string
  x402_max_per_call_usd_micros?: number | string
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
  /** Depth of the current delegation chain, so a team cannot recurse forever. */
  delegationDepth?: number
  /** Comma-separated teammate names, shown to the model when a delegation target is wrong. */
  roster?: string
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

const MAX_DELEGATION_DEPTH = 3
const MAX_TOOL_RESULT_CHARS = 4000

function asMcpServers(v: McpServerConfig[] | string): McpServerConfig[] {
  if (Array.isArray(v)) return v
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : [] } catch { return [] }
}

/** Built-in http_fetch tool when the agent has x402 enabled. */
const DELEGATE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'delegate_to_agent',
    description:
      'Delegate one bounded task to a named teammate agent and get its report back. Use it for work outside your own remit. The teammate runs with its own system prompt, budget and step limit; you receive a short report, not its transcript.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Teammate name exactly as listed in your roster, e.g. QA' },
        task: { type: 'string', description: 'A self-contained instruction. The teammate cannot see this conversation.' },
      },
      required: ['agent', 'task'],
    },
  },
}

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
  const startedAt = Date.now()
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
    // Bounded await, not fire-and-forget. A serverless function stops the moment the response
    // is returned, so an un-awaited export never leaves the process. The race keeps the run
    // safe from a slow vendor while still giving the span a chance to land.
    const spanExport = emitAgentRunSpan({
      traceId: traceIdFrom(runId),
      spanId: spanIdFrom(runId),
      name: `agent.run ${agent.name}`,
      startMs: startedAt,
      endMs: Date.now(),
      attributes: {
        'agent.id': agent.id,
        'agent.name': agent.name,
        'agent.model': agent.model,
        'agent.status': status,
        'agent.tool_calls': toolCalls,
        'agent.spend_usd_micros': spend,
        'run.id': runId,
        ...(error ? { 'agent.error': error.slice(0, 300) } : {}),
      },
    })
    await Promise.race([spanExport, new Promise((resolve) => setTimeout(resolve, 1200))])
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
  if ((agent as any).can_delegate) tools.push(DELEGATE_TOOL)
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
        const debit = await debitForUsage(user.id, cost, `agent:${runId}`, {
          allowNegative: await isCovered(user.wallet),
        })
        if (!debit.ok) {
          return await finish('error', null, toolCalls, spend, 'Insufficient credits. Top up with USDC (Base) or USDG (Robinhood Chain) on the Deposit page.')
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
              const sellers = typeof agent.x402_allowed_sellers === 'string'
                ? JSON.parse(agent.x402_allowed_sellers || '[]')
                : (agent.x402_allowed_sellers ?? [])
              const r = await paidFetch(String(args.url), {
                method: args.method === 'POST' ? 'POST' : 'GET',
                headers: args.body ? { 'content-type': 'application/json' } : undefined,
                body: args.body,
              }, {
                maxSpendUsdMicros: Number(agent.x402_max_per_call_usd_micros ?? 20000),
                allowedSellers: sellers,
              })
              const text = await r.response.text()
              if (r.blocked) {
                // Surface the refusal to the model so it stops retrying this seller.
                result = `Payment blocked: ${r.blocked.reason}. No payment was made. HTTP ${r.response.status}: ${text.slice(0, 500)}`
              } else {
                result = `HTTP ${r.response.status}${r.paid ? ' (x402 paid)' : ''}: ${text.slice(0, MAX_TOOL_RESULT_CHARS)}`
                if (r.paid) {
                  // Record the payment and ask the seller to verify it. This never
                  // throws: a partner being unreachable must not break a settled payment.
                  void recordAndVerifyPayment({
                    runId,
                    url: String(args.url),
                    header: r.response.headers.get('x-payment-response'),
                    spentMicros: r.spentUsdMicros,
                  })
                }
                if (r.spentUsdMicros > 0) {
                  spend += r.spentUsdMicros
                  if (spend > budget) {
                    return await finish('error', null, toolCalls, spend, 'Budget exceeded (x402 payments counted)')
                  }
                }
              }
            } else if (tc.function.name === 'delegate_to_agent' && (agent as any).can_delegate) {
              const depth = Number((deps as any).delegationDepth ?? 0)
              if (depth >= MAX_DELEGATION_DEPTH) {
                result = `Delegation refused: depth limit ${MAX_DELEGATION_DEPTH} reached. Do the work yourself or report the blocker.`
              } else {
                const wanted = String(args.agent || '').trim()
                const child = await one(
                  `SELECT * FROM agents WHERE user_id = $1 AND lower(name) = lower($2) AND status = 'active' AND id <> $3 LIMIT 1`,
                  [user.id, wanted, agent.id]
                )
                if (!child) {
                  result = `No active teammate named "${wanted}". Your roster: ${(deps as any).roster ?? 'unavailable'}.`

                } else {
                  // The delegation boundary is a contract: check the task against the
                  // blueprint schema before a teammate spends money on it.
                  const taskDoc = {
                    task_id: `${agent.id}:${String(args.task || '').slice(0, 24)}:${Date.now()}`,
                    project_id: 'thirdeye-ai',
                    title: String(args.task || '').slice(0, 80) || 'delegated task',
                    objective: String(args.task || ''),
                    owner: String(wanted).toLowerCase(),
                    created_by: String(agent.name).toLowerCase(),
                    status: 'assigned',
                    priority: 'normal',
                    acceptance_criteria: ['a report with evidence, tests and risks'],
                    created_at: new Date().toISOString(),
                  }
                  const taskCheck = validateTask(taskDoc)
                  if (!taskCheck.ok) {
                    result = `Delegation refused: the task did not validate against task.schema.json (${taskCheck.errors.join('; ')}). Rewrite it as one bounded instruction.`
                  } else {
                  const childRun = await runAgent(
                    child as AgentRow,
                    `[delegated by ${agent.name}] ${String(args.task || '').slice(0, 4000)}`,
                    user,
                    { delegationDepth: depth + 1 }
                  )
                  result = `REPORT from ${child.name} (status ${childRun.status})` +
                    (childRun.output ? `: ${String(childRun.output).slice(0, MAX_TOOL_RESULT_CHARS)}` : '') +
                    (childRun.error ? ` error: ${String(childRun.error).slice(0, 400)}` : '') +
                    ` [spend ${childRun.spend_usd_micros ?? 0} micros]`
                  }
                }
              }
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


/**
 * Persist an x402 payment our agent made and ask the partner to verify it.
 * Failures here are recorded, never thrown: the run has already paid.
 */
async function recordAndVerifyPayment(input: {
  runId: string
  url: string
  header: string | null
  spentMicros: number
}): Promise<void> {
  try {
    let decoded: any = null
    try {
      const { decodeXPaymentResponse } = await import('x402-fetch')
      if (input.header) decoded = decodeXPaymentResponse(input.header)
    } catch { /* header shape unknown; fall back to a regex scan */ }

    const txHash = txHashFrom(decoded, input.header)
    let host = ''
    try { host = new URL(input.url).host } catch { host = input.url.slice(0, 80) }
    const expected = {
      recipient: decoded?.payTo ?? decoded?.recipient ?? null,
      token: decoded?.asset ?? decoded?.token ?? null,
      amount_units: decoded?.maxAmountRequired ?? decoded?.amount ?? String(input.spentMicros),
    }

    const check = await verifyPayment({ txHash, chain: 'base', method: 'x402', expected })
    await query(
      `INSERT INTO agent_run_payments
         (id, run_id, seller_host, tx_hash, chain, method, expected, verified_onchain, confirmations, replay, status, response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(), input.runId, host, txHash, 'base', 'x402', JSON.stringify(expected),
        check.verifiedOnchain, check.confirmations, check.replay, check.status, JSON.stringify(check.raw),
      ]
    )
  } catch { /* bookkeeping only; never surface to the caller */ }
}
