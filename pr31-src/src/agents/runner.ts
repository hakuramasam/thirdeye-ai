/**
 * Autonomous agent runner: LLM loop with MCP tools, optional x402-paid
 * http_fetch, per-step billing against the user ledger, per-run budget.
 */

import { randomUUID } from 'node:crypto'
import { query, one } from '../db/index.js'
import { env } from '../lib/env.js'
import { debitForUsage } from '../lib/billing.js'
import { payForStep } from './credit.js'
import { callWithRateLimitRetry } from './retry.js'
import { isCovered } from '../lib/allowance.js'
import { computeCostMicros } from '../lib/pricing.js'
import { getModelRow, type ProviderCall } from '../providers/index.js'
import { createMcpTools, type McpTools, type McpServerConfig } from './mcp.js'
import { validateTask } from '../team/validate.js'
import { emitAgentRunSpan, traceIdFrom, spanIdFrom } from '../telemetry/langfuse.js'
import { paidFetch } from './x402.js'
import { REPO_TOOL, runRepoTool, hasRepoAccess } from './repo-tools.js'
import { REPO_WRITE_TOOL, runRepoWrite } from './repo-write.js'
import { logRunEvent } from './monitor.js'
import {
  newCorrelationId,
  createAuditEvent,
  recordRunEvent,
  recordRunCompleted,
  recordRunFailed,
  recordTaskDelegated,
  recordTaskOutcome,
  recordToolInvocation,
  recordStageTransition,
  readStageLedger,
  type AuditContext,
} from './audit-log.js'
import { planForPipeline } from './pipeline.js'
import {
  storeArtifact,
  describeArtifact,
  kindForStage,
  readArtifactWindow,
  MAX_ARTIFACT_READ_CHARS,
  type StoredArtifact,
} from './artifacts.js'
import { assertPublicUrl } from '../lib/ssrf.js'
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
  /**
   * Idempotency key for this run. Callers that run a schedule slot pass the run id from
   * agent_schedule_lock, so a replay of the same slot cannot create a second run row.
   */
  runId?: string
  /** Depth of the current delegation chain, so a team cannot recurse forever. */
  delegationDepth?: number
  /** Set by a write-enabled orchestrator to grant this run repo_write for one task. */
  allowWrite?: boolean
  /** Comma-separated teammate names, shown to the model when a delegation target is wrong. */
  roster?: string
  /**
   * Execution audit (PH2-001). A root execution gets a fresh correlation id; every delegated run
   * inherits it, so one id reconstructs the whole chain. `parentRunId` is the run that delegated,
   * and task/pipeline/stage travel with the work rather than being guessed from timing later.
   */
  correlationId?: string
  parentRunId?: string
  taskId?: string
  pipelineId?: string
  stageId?: string
  /** Injectable for tests; default resolves via the provider layer. */
  llm?: { call(params: Record<string, any>): Promise<LlmResult> }
  mcpTools?: McpTools
  /**
   * Internal: counters handed in by `runAgent` so the crash path can still write what the run
   * actually did. Set by the caller of `runAgent`, never by a feature.
   */
  progress?: RunProgress
}

/** Live per-run counters, shared between the body and the crash path. */
export type RunProgress = { toolCalls: number; spendUsdMicros: number }

export type RunResult = {
  runId: string
  status: 'success' | 'error'
  output: string | null
  tool_calls: number
  spend_usd_micros: number
  error: string | null
  /** True when this call did not run anything because the run id was already used. */
  replayed?: boolean
  /**
   * Address of this run's output in the artifact registry (PH2-003). Present on a successful run
   * that produced text, so a caller hands on an address instead of a truncated copy.
   */
  artifact?: StoredArtifact
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
        allow_write: {
          type: 'boolean',
          description:
            'Grant the teammate repo_write for this one task: it may open a pull request, never commit to main. Only a write-enabled orchestrator can grant this, and the grant is recorded in the report. Leave false unless the task is a code change that should be proposed for review.',
        },
      },
      required: ['agent', 'task'],
    },
  },
}

/**
 * Reading a handoff by address. Available to every agent, because a handoff arrives from a
 * teammate and the whole point of the registry is that the reader can fetch the bytes itself
 * instead of trusting a summary. No spend, so it is not gated on x402 or repo authority.
 */
const READ_ARTIFACT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_artifact',
    description:
      'Read an artifact a teammate stored, by address (art_...). Use it when a report tells you the full document lives at an address. Returns the text from offset, up to the character cap, and tells you the next offset when there is more.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact address, e.g. art_3f9c1a2b4d5e6f7a8b9c' },
        offset: { type: 'number', description: 'Character offset to start from. Default 0.' },
        limit: { type: 'number', description: `How many characters to return. Default and maximum ${MAX_ARTIFACT_READ_CHARS}.` },
      },
      required: ['id'],
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

/**
 * Crash-safe entry point. The runner used to leave agent_runs stuck at 'running' with no
 * error whenever an unexpected throw escaped a step (observed in production on 2026-11-09
 * when the orchestrator died mid-mission). Every run now terminates as success or error.
 */
export async function runAgent(
  agent: AgentRow,
  input: string,
  user: UserRow,
  deps: RunnerDeps = {}
): Promise<RunResult> {
  const runId = deps.runId || randomUUID()
  const correlationId = deps.correlationId || newCorrelationId()
  /**
   * The run's own counters, owned here rather than inside the body: a throw skips `finish()`,
   * and that used to close the run as error with spend and tool_calls still at zero even though
   * the steps had already been paid for out of the agent's pot. The two numbers are the only
   * record of what a crashed run cost, so they have to survive the throw.
   */
  const progress: RunProgress = { toolCalls: 0, spendUsdMicros: 0 }
  try {
    return await runAgentInner(agent, input, user, { ...deps, runId, correlationId, progress })
  } catch (e: any) {
    const message = String(e?.message || e).slice(0, 500)
    try {
      await query(
        `UPDATE agent_runs SET status='error', error=$1, tool_calls=$2, spend_usd_micros=$3
          WHERE id=$4 AND status='running'`,
        [`uncaught: ${message}`, progress.toolCalls, progress.spendUsdMicros, runId]
      )
      await query(`UPDATE agents SET last_run_at = now() WHERE id = $1`, [agent.id])
    } catch {
      /* the run row is best-effort here; the caller still gets the error */
    }
    try {
      await recordRunFailed(
        {
          correlationId,
          runId,
          parentRunId: deps.parentRunId ?? null,
          taskId: deps.taskId ?? null,
          agentId: agent.id,
          agentRole: agent.name,
          pipelineId: deps.pipelineId ?? null,
          stageId: deps.stageId ?? null,
        },
        {
          errorCode: 'uncaught_exception',
          errorSummary: message,
          // The run row above now holds the real counters, so the audit event has to agree with
          // it or the ledger still says a crashed run cost nothing.
          toolCalls: progress.toolCalls,
          spendMicros: progress.spendUsdMicros,
        }
      )
    } catch {
      /* an audit note is best effort on the crash path too: the caller still gets the error */
    }
    return {
      runId,
      status: 'error',
      output: null,
      tool_calls: progress.toolCalls,
      spend_usd_micros: progress.spendUsdMicros,
      error: `uncaught: ${message}`,
    }
  }
}

/**
 * One verdict per tool call, used by both the run history and the audit trail.
 *
 * It is stated from the call site rather than guessed from the result text, because a successful
 * handoff carries the note "[write withheld]" when no write authority was granted, and the old
 * whole-text heuristic read that as a refusal. Two answers are still only visible in the text,
 * because the repo writers report them without throwing: `repo_write refused: ...` is an
 * authorization decision, and `repo_write failed: ...` reached GitHub and did not land. Without
 * these two the working log would call a refused write a success.
 */
export function classifyCallOutcome(denied: string | null, result: unknown): { refused: boolean; ok: boolean } {
  const text = String(result ?? '').trim()
  const refused = Boolean(denied) || /^repo_write refused\b/i.test(text)
  const ok = !refused && !/^(?:Tool error|Unknown tool|Tool unavailable|repo_write failed)\b/i.test(text)
  return { refused, ok }
}

async function runAgentInner(
  agent: AgentRow,
  input: string,
  user: UserRow,
  deps: RunnerDeps = {}
): Promise<RunResult> {
  const runId = deps.runId || randomUUID()
  const correlationId = deps.correlationId || newCorrelationId()
  /** Every audit event of this execution carries the same correlation and parent link. */
  const audit: AuditContext = {
    correlationId,
    runId,
    parentRunId: deps.parentRunId ?? null,
    taskId: deps.taskId ?? null,
    agentId: agent.id,
    agentRole: agent.name,
    pipelineId: deps.pipelineId ?? null,
    stageId: deps.stageId ?? null,
  }
  const startedAt = Date.now()
  const budget = Number(agent.budget_usd_micros)
  const maxSteps = Math.min(Math.max(agent.max_steps || 8, 1), 20)

  const inserted = await query(
    `INSERT INTO agent_runs (id, agent_id, user_id, status, input) VALUES ($1, $2, $3, 'running', $4)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [runId, agent.id, user.id, input]
  )
  if (inserted.rowCount === 0) {
    // Same idempotency key seen before: return the recorded outcome instead of re-running
    // and re-charging. This is what makes a duplicated cron tick harmless.
    const existing = await one(`SELECT status, output, tool_calls, spend_usd_micros, error FROM agent_runs WHERE id = $1`, [runId])
    return {
      runId,
      status: (existing?.status === 'success' ? 'success' : 'error') as 'success' | 'error',
      output: existing?.output ?? null,
      tool_calls: Number(existing?.tool_calls ?? 0),
      spend_usd_micros: Number(existing?.spend_usd_micros ?? 0),
      error: existing?.error ?? 'duplicate run id (replay)',
      replayed: true,
    }
  }

  // The run row exists, so the execution is real: make that visible in the audit trail before any
  // work is done. A replay returned above and deliberately writes nothing.
  await recordRunEvent(audit, 'run.created', { metadata: { model: agent.model, max_steps: maxSteps } })
  await recordRunEvent(audit, 'run.started')

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
    /**
     * Address the output before anything hands it on (PH2-003). A store failure must not turn a
     * finished run into a failed one, and it must not be silent either: the run record keeps the
     * text, and the audit trail gets a row saying the registry refused it.
     */
    let artifact: StoredArtifact | undefined
    if (status === 'success' && output && output.trim()) {
      try {
        artifact = await storeArtifact(
          {
            userId: user.id,
            kind: kindForStage(deps.pipelineId, deps.stageId),
            content: output,
            title: `${agent.name}: ${kindForStage(deps.pipelineId, deps.stageId)}${deps.stageId ? ` (${deps.stageId})` : ''}`,
            correlationId,
            runId,
            parentRunId: deps.parentRunId ?? null,
            taskId: deps.taskId ?? null,
            pipelineId: deps.pipelineId ?? null,
            stageId: deps.stageId ?? null,
            createdBy: agent.name,
            metadata: { steps: toolCalls, model: agent.model },
          },
          audit
        )
      } catch (e: any) {
        await createAuditEvent({
          ...audit,
          eventType: 'run.completed',
          status: 'succeeded',
          metadata: { artifact_store_failed: true, reason: String(e?.message ?? e).slice(0, 300) },
        }).catch(() => null)
      }
    }
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
    // Audit last, so the record describes the state the run actually reached.
    if (status === 'success') {
      await recordRunCompleted(audit, { toolCalls, spendMicros: spend })
    } else {
      await recordRunFailed(audit, {
        errorCode: errorCodeFrom(error),
        errorSummary: error,
        toolCalls,
        spendMicros: spend,
      })
    }
    return { runId, status, output, tool_calls: toolCalls, spend_usd_micros: spend, error, ...(artifact ? { artifact } : {}) }
  }

  // Resolve model + LLM. The catalogue row is resolved even when a model is injected, because it
  // is what prices each step: without it the run cannot record what it spent, which is exactly the
  // hole the crash path below was fixed to close. An injected model whose id is not in the
  // catalogue still prices at zero, so nothing changes for the existing tests.
  const modelRow: ModelRow | null = await getModelRow(agent.model)
  let llm = deps.llm
  if (!llm) {
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
  // Every agent may read an artifact handed to it, including one delegated to by an orchestrator.
  tools.push(READ_ARTIFACT_TOOL)
  if ((agent as any).can_delegate) tools.push(DELEGATE_TOOL)
  if (agent.x402_enabled) tools.push(HTTP_FETCH_TOOL)
  // Write is granted per run, not per agent row: an orchestrator may hand one task write
  // authority and withhold it from the next, so the grant travels with the run.
  const canWrite = deps.allowWrite ?? ((agent as any).repo_access === 'write')
  if (hasRepoAccess((agent as any).repo_access)) tools.push(REPO_TOOL)
  if (canWrite) tools.push(REPO_WRITE_TOOL)

  try {
    const messages: any[] = [
      { role: 'system', content: agent.system_prompt },
      { role: 'user', content: input },
    ]
    const useTools = tools.length > 0
    const progress: RunProgress = deps.progress ?? { toolCalls: 0, spendUsdMicros: 0 }
    let spend = 0
    let toolCalls = 0
    let byok = false
    try {
      const { resolveProvider } = await import('../providers/index.js')
      byok = modelRow ? (await resolveProvider(user, modelRow)).byok : false
    } catch { byok = false }

    for (let step = 0; step < maxSteps; step++) {
      // A free-tier meter can refuse a step that would have succeeded seconds later, and a
      // scheduled run has nobody to retry it. Wait out only what the provider told us to.
      const res = await callWithRateLimitRetry(() => llm!.call(useTools ? { messages, tools } : { messages }))
      const cost =
        modelRow != null
          ? computeCostMicros(modelRow, res.prompt_tokens, res.completion_tokens, env.platformMarginPct, byok)
          : 0
      if (cost > 0) {
        // The agent's own pot pays first, the owner's ledger covers the rest. A step that
        // neither can settle in full is refused rather than half-charged.
        const paid = await payForStep({
          agentId: agent.id,
          userId: user.id,
          wallet: user.wallet,
          runId,
          costMicros: cost,
        })
        if (!paid.ok) {
          return await finish('error', null, toolCalls, spend, 'Insufficient credits. Top up with USDC (Base) or USDG (Robinhood Chain) on the Deposit page.')
        }
        spend += cost
        progress.spendUsdMicros = spend
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
          // Set when a tool was refused rather than unknown: that is an authorization decision and
          // belongs in the audit trail as `tool.denied`, not as a broken call.
          let denied: string | null = null
          try {
            const args = JSON.parse(tc.function.arguments || '{}')
            if (tc.function.name === 'repo_write' && canWrite) {
              result = await runRepoWrite(args)
            } else if (tc.function.name === 'repo_read' && hasRepoAccess((agent as any).repo_access)) {
              result = await runRepoTool(args)
            } else if (tc.function.name === 'http_fetch' && agent.x402_enabled) {
              const sellers = typeof agent.x402_allowed_sellers === 'string'
                ? JSON.parse(agent.x402_allowed_sellers || '[]')
                : (agent.x402_allowed_sellers ?? [])
              // Validate before dialling: x402-fetch owns its own HTTP client, so we cannot
              // pin the socket here, but a non-public target must never be paid for either.
              await assertPublicUrl(String(args.url), { allowHosts: env.mcpAllowedHosts })
              const r = await paidFetch(String(args.url), {
                method: args.method === 'POST' ? 'POST' : 'GET',
                headers: args.body ? { 'content-type': 'application/json' } : undefined,
                body: args.body,
              }, {
                maxSpendUsdMicros: Number(agent.x402_max_per_call_usd_micros ?? 20000),
                allowedSellers: sellers,
              })
              // The payment is already debited by paidFetch, so it is counted before the body is
              // read: a body that never arrives must not make a settled payment look free in the
              // run's accounting. The verification ask needs only the headers, so it moves up too.
              if (r.paid) {
                // Never throws: a partner being unreachable must not break a settled payment.
                void recordAndVerifyPayment({
                  runId,
                  url: String(args.url),
                  header: r.response.headers.get('x-payment-response'),
                  spentMicros: r.spentUsdMicros,
                })
              }
              if (!r.blocked && r.spentUsdMicros > 0) {
                spend += r.spentUsdMicros
                progress.spendUsdMicros = spend
                if (spend > budget) {
                  return await finish('error', null, toolCalls, spend, 'Budget exceeded (x402 payments counted)')
                }
              }
              const text = await r.response.text()
              if (r.blocked) {
                // Surface the refusal to the model so it stops retrying this seller.
                result = `Payment blocked: ${r.blocked.reason}. No payment was made. HTTP ${r.response.status}: ${text.slice(0, 500)}`
              } else {
                result = `HTTP ${r.response.status}${r.paid ? ' (x402 paid)' : ''}: ${text.slice(0, MAX_TOOL_RESULT_CHARS)}`
              }
            } else if (tc.function.name === 'delegate_to_agent' && (agent as any).can_delegate) {
              const depth = Number((deps as any).delegationDepth ?? 0)
              if (depth >= MAX_DELEGATION_DEPTH) {
                denied = `delegation depth limit ${MAX_DELEGATION_DEPTH} reached`
                result = `Delegation refused: depth limit ${MAX_DELEGATION_DEPTH} reached. Do the work yourself or report the blocker.`
              } else {
                const wanted = String(args.agent || '').trim()
                const child = await one(
                  `SELECT * FROM agents WHERE user_id = $1 AND lower(name) = lower($2) AND status = 'active' AND id <> $3 LIMIT 1`,
                  [user.id, wanted, agent.id]
                )
                if (!child) {
                  denied = `no active teammate named "${wanted}"`
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
                    denied = 'task did not validate against task.schema.json'
                    result = `Delegation refused: the task did not validate against task.schema.json (${taskCheck.errors.join('; ')}). Rewrite it as one bounded instruction.`
                  } else {
                  // Deterministic order (PH2-002). Active only when a caller declared a pipeline,
                  // so free-form delegation is untouched. With one declared, the pipeline's next
                  // stage is the only permitted move, so order no longer depends on which tool
                  // call the model happened to make first.
                  const pinnedStage = deps.stageId ?? null
                  // Order enforcement is for delegations the model chooses. When the caller pins
                  // a stage, the caller is the driver following its own plan, so the pipeline
                  // does not second-guess the choice; the stage is still recorded, which makes
                  // the trail read as a sequence instead of a list.
                  const enforcePipeline = Boolean(deps.pipelineId) && !pinnedStage
                  const stagePlan = enforcePipeline
                    ? planForPipeline(deps.pipelineId, await readStageLedger(correlationId))
                    : ({ ok: true as const, stage: null, index: -1, attempt: 1 })
                  const stageOwner = stagePlan.ok ? stagePlan.stage?.owner ?? null : null
                  // Pipelines name stages by agent id (tdt_architect); a run knows the child's id
                  // and its display name, so either is accepted rather than silently mismatching.
                  const ownerKeys = [String((child as any).id ?? ''), String((child as any).name ?? '')]
                    .map((v) => v.toLowerCase())
                  const wrongOwner = Boolean(stageOwner) && !ownerKeys.includes(String(stageOwner).toLowerCase())
                  if (!stagePlan.ok) {
                    denied = stagePlan.code
                    result = `Delegation refused: ${stagePlan.message}. Do the work this pipeline allows, or report the blocker.`
                  } else if (wrongOwner) {
                    denied = 'stage_owner_mismatch'
                    result = `Delegation refused: pipeline ${deps.pipelineId} expects stage "${stagePlan.stage!.id}" from ${stageOwner}, not ${String((child as any).name ?? wanted)}. Delegate to ${stageOwner}, or report the blocker.`
                  } else {
                  // A grant is only real if the parent holds write itself and the child is a
                  // member of the repo-access roster; a model cannot widen its own authority.
                  const granted = Boolean(args.allow_write) && canWrite && hasRepoAccess((child as any).repo_access)
                  // Fail closed on the handoff. Authority is about to travel to another agent, so
                  // the grant must be reconstructable later; if that record cannot be written, the
                  // handoff does not happen. Everything else in this loop stays best effort.
                  let handoffRecorded = false
                  try {
                    await recordTaskDelegated(audit, {
                      taskId: taskDoc.task_id,
                      toAgentId: (child as any).id,
                      metadata: { to_agent: String((child as any).name ?? wanted), allow_write: granted, depth: depth + 1 },
                    })
                    handoffRecorded = true
                  } catch (e: any) {
                    denied = 'audit log unavailable for the handoff'
                    result = `Delegation refused: the audit log could not record this handoff, so no authority was passed (${String(e?.message ?? e).slice(0, 200)}). Do the work yourself or report the blocker.`
                  }
                  if (handoffRecorded) {
                    // Claim the stage in the trail before any work starts, so a second delegation
                    // in the same correlation sees it in flight instead of running it twice. Fail
                    // closed like the handoff: an unrecorded stage claim means no stage at all.
                    const stageId = pinnedStage ?? (stagePlan.ok ? stagePlan.stage?.id : null) ?? deps.stageId
                    const inPipeline = Boolean(stageId && deps.pipelineId)
                    let stageClaimed = true
                    if (inPipeline) {
                      try {
                        await recordStageTransition(audit, {
                          stageId: String(stageId),
                          eventType: 'stage.started',
                          metadata: {
                            pipeline: deps.pipelineId,
                            owner: stageOwner,
                            attempt: stagePlan.ok ? stagePlan.attempt : 1,
                          },
                        })
                      } catch (e: any) {
                        stageClaimed = false
                        denied = 'audit log unavailable for the stage claim'
                        result = `Delegation refused: the stage could not be recorded as started, so it was not started (${String(e?.message ?? e).slice(0, 200)}). Do the work yourself or report the blocker.`
                      }
                    }
                    if (stageClaimed) {
                    const childRun = await runAgent(
                      child as AgentRow,
                      `[delegated by ${agent.name}] ${String(args.task || '').slice(0, 4000)}`,
                      user,
                      {
                        delegationDepth: depth + 1,
                        allowWrite: granted,
                        // The child inherits the chain: same correlation, this run as its parent, and
                        // the task id, so one id traces the whole delegated action.
                        correlationId,
                        parentRunId: runId,
                        taskId: taskDoc.task_id,
                        pipelineId: deps.pipelineId,
                        stageId: stageId ?? deps.stageId,
                        // Only ever present when a caller injected one (tests); in production this is
                        // undefined and the provider is resolved per agent.
                        llm: deps.llm,
                        roster: deps.roster,
                      }
                    )
                    await recordTaskOutcome(
                      { ...audit, agentId: (child as any).id, agentRole: (child as any).name },
                      childRun.status === 'success' ? 'task.completed' : 'task.rejected',
                      { taskId: taskDoc.task_id, metadata: { child_run_id: childRun.runId, write_granted: granted } }
                    )
                    /** Inline head stays short; the rest is addressable, so nothing is lost. */
                    const HANDOFF_HEAD = 1200
                    result = `REPORT from ${child.name} (status ${childRun.status})` +
                      (childRun.artifact
                        ? ` [artifact ${describeArtifact(childRun.artifact)}: full text at that address, read it with read_artifact if you need more than this head]`
                        : '') +
                      (childRun.output
                        ? `: ${String(childRun.output).slice(0, childRun.artifact ? HANDOFF_HEAD : MAX_TOOL_RESULT_CHARS)}` +
                          (childRun.artifact && String(childRun.output).length > HANDOFF_HEAD ? ' …' : '')
                        : '') +
                      (childRun.error ? ` error: ${String(childRun.error).slice(0, 400)}` : '') +
                      ` [spend ${childRun.spend_usd_micros ?? 0} micros]` +
                      (granted ? ' [write granted for this task]' : ' [write withheld]')
                    if (inPipeline) {
                      // Best effort: the child's own run.created/run.completed events already carry
                      // its outcome, so a failed stage note degrades the story without hiding the
                      // work. Ordering stays conservative: an unwritten completion is not a
                      // settled stage, so the pipeline will not advance past it by accident.
                      await recordStageTransition(audit, {
                        stageId: String(stageId),
                        eventType: childRun.status === 'success' ? 'stage.completed' : 'stage.failed',
                        metadata: {
                          pipeline: deps.pipelineId,
                          owner: stageOwner,
                          child_run_id: childRun.runId,
                          write_granted: granted,
                          ...(childRun.status === 'success' ? {} : { error: String(childRun.error ?? '').slice(0, 300) }),
                        },
                      }).catch(() => null)
                    }
                    }
                  }
                  }
                  }
                }
              }
            } else if (tc.function.name === 'repo_write') {
              denied = 'repo_write requires write authority, which this run does not hold'
              result = `Refused: repo_write needs write authority for this run. Put the proposed change in your report instead.`
            } else if (tc.function.name === 'repo_read') {
              denied = 'repo_read requires repo access on this agent'
              result = `Refused: this agent has no repo access.`
            } else if (tc.function.name === 'http_fetch') {
              denied = 'http_fetch requires x402 to be enabled'
              result = `Refused: http_fetch is disabled for this agent.`
            } else if (mcpTools) {
              result = (await mcpTools.call(tc.function.name, args)).slice(0, MAX_TOOL_RESULT_CHARS)
            } else {
              result = `Unknown tool: ${tc.function.name}`
            }
          } catch (e: any) {
            result = `Tool error: ${String(e?.message || e).slice(0, 300)}`
          }
          toolCalls++
          progress.toolCalls = toolCalls
          // One verdict per call, used by both the run history and the audit trail. It is stated
          // here rather than guessed from the result text downstream: a successful delegation
          // carries the note "[write withheld]" when no write authority was granted, and the
          // text heuristic in logRunEvent read that as a refused call.
          const { refused: callRefused, ok: callOk } = classifyCallOutcome(denied, result)
          // Per-call history. Best-effort: a logging failure must never fail a run the user paid for.
          try {
            await logRunEvent({
              runId,
              agentId: agent.id,
              seq: toolCalls,
              tool: tc.function.name,
              ok: callOk,
              refused: callRefused,
              argsExcerpt: String(tc.function.arguments ?? ''),
              resultExcerpt: String(result ?? ''),
            })
          } catch {}
          try {
            await recordToolInvocation(audit, {
              tool: tc.function.name,
              ok: callOk,
              refused: callRefused,
              argsExcerpt: String(tc.function.arguments ?? ''),
              resultExcerpt: String(result ?? ''),
              metadata: { seq: toolCalls, ...(denied ? { denial_reason: denied } : {}) },
            })
          } catch {}
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

/** A stable code for the audit row, so failures can be counted without parsing prose. */
export function errorCodeFrom(message?: string | null): string {
  const m = String(message ?? '')
  if (/insufficient credits/i.test(m)) return 'insufficient_credits'
  if (/budget exceeded/i.test(m)) return 'budget_exceeded'
  if (/max steps/i.test(m)) return 'max_steps'
  if (/model '.*' not found/i.test(m)) return 'model_not_found'
  if (/audit log unavailable/i.test(m)) return 'audit_unavailable'
  if (/uncaught:/i.test(m)) return 'uncaught_exception'
  return 'run_failed'
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
