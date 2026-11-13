/**
 * Public discovery surfaces for partners and peer agents.
 *
 * Everything here is additive: no existing route, price or behaviour changes.
 * The only data exposed is what a partner needs to route on cost and address us
 * as a peer. No keys, no user data, no balances.
 */
import { Hono } from 'hono'
import { query } from '../db/index.js'
import { env } from '../lib/env.js'
import type { AppEnv } from '../lib/types.js'

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://thirdeye-ai-alpha.vercel.app'
const SERVICE_VERSION = '0.2.0'
const UPDATED_AT = '2026-11-07'

const PACKAGE_VERSION = '0.1.0'

const MARGIN_PCT = Number(process.env.PLATFORM_MARGIN_PCT ?? 10)

/** Catalogue price is what the upstream provider charges; billed adds our margin. */
export function pricePer1m(micros: number | string, marginPct = MARGIN_PCT): { catalog_usd: number; billed_usd: number } {
  const catalog = Number(micros) / 1_000_000
  const billed = catalog * (1 + marginPct / 100)
  return { catalog_usd: Number(catalog.toFixed(6)), billed_usd: Number(billed.toFixed(6)) }
}

export function capabilityCard(): Record<string, unknown> {
  return {
    service: 'thirdeye-gateway',
    version: SERVICE_VERSION,
    updated_at: UPDATED_AT,
    operator: 'Thirdeye AI',
    protocols: ['openai-compatible', 'http-json', 'a2a-jsonrpc', 'mcp-client', 'x402-payer'],
    endpoints: {
      chat: `${BASE_URL}/api/v1/chat/completions`,
      models_public: `${BASE_URL}/api/models/public`,
      capabilities: `${BASE_URL}/api/partner/capabilities`,
      agent_card: `${BASE_URL}/.well-known/agent-card.json`,
      a2a: `${BASE_URL}/a2a`,
      health: `${BASE_URL}/api/healthz`,
      partner_hub: `${BASE_URL}/partner`,
      keys: `${BASE_URL}/api/keys`,
    },
    limits: {
      starter_credit_usd: 0.02,
      billing: 'per user account, prepaid ledger, no sub-accounts or reseller pools',
      per_key_limits: ['requests per minute', 'tokens per minute', 'revocation'],
      x402_outgoing_per_call_cap_usd: 0.02,
    },
    strengths: [
      'brokered LLM inference on OpenAI-compatible HTTP',
      'measured per-call billing with the billed cost returned on every response header',
      'BYOK routing for callers who bring their own provider keys',
      'x402 payer with a fail-closed seller allowlist and a hard per-call cap',
      'agent runtime with run budgets, tool calls and MCP client support',
    ],
    gaps_we_do_not_fill: [
      'onchain market data and price oracles',
      'wallet forensics and holder analytics',
      'payment verification against third-party receipts',
      'scheduling and job orchestration beyond per-agent cron',
    ],
    peers: [
      {
        name: 'Vesper Intelligence',
        role: 'complementary, not competitor',
        kind: 'onchain data skills over MCP and x402',
        capabilities: 'https://vesper-mcp-gateway.layer2.workers.dev/capabilities',
        mcp: 'https://vesper-mcp-gateway.layer2.workers.dev/mcp',
        hub: `${BASE_URL}/partner`,
      },
    ],
  }
}

export function agentCard(): Record<string, unknown> {
  return {
    protocolVersion: '0.2.1',
    name: 'Thirdeye AI',
    description:
      'Brokered LLM inference and an agent runtime on Base. Per-call USDC billing, OpenAI-compatible API, x402 payer, MCP client.',
    url: `${BASE_URL}/a2a`,
    preferredTransport: 'JSONRPC',
    version: PACKAGE_VERSION,
    provider: { organization: 'Thirdeye AI', url: BASE_URL },
    documentationUrl: `${BASE_URL}/api/partner/capabilities`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'llm_inference',
        name: 'Brokered LLM inference',
        description:
          'Send messages to a chosen model over an OpenAI-compatible endpoint. Billed per call from a prepaid balance, with the exact cost returned in the x-thirdeye-cost-usd header.',
        tags: ['llm', 'inference', 'openai-compatible'],
        examples: ['Summarise this filing in three bullets', 'Draft five caption variants for a launch post'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'agent_runtime',
        name: 'Agent runtime',
        description:
          'Run a configured agent with tool calls, MCP servers, a per-run budget and a cron schedule. Runs are recorded and auditable.',
        tags: ['agents', 'tools', 'mcp', 'scheduling'],
        examples: ['Run the market watcher profile against a watchlist'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'cost_routing',
        name: 'Cost-aware model routing',
        description:
          'Public model catalogue with input and output prices per million tokens, so a peer can pick the cheapest model that fits the task before calling.',
        tags: ['pricing', 'routing', 'catalog'],
        examples: ['Which model costs least for a 200 token classification?'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
  }
}

/** A2A JSON-RPC. Answers addressing and capability questions, and never spends on inference. */
export function a2aResponse(method: string, params: any, id: unknown): { status: number; body: unknown } {
  const rpcError = (code: number, message: string) => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
  })

  if (method === 'agent/getCard' || method === 'agent/authenticatedExtendedCard') {
    return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result: agentCard() } }
  }

  if (method === 'message/send' || method === 'message/stream') {
    if (method === 'message/stream') return rpcError(-32601, 'Streaming is not supported; use message/send')
    const text =
      'Thirdeye AI is addressable as a peer. This endpoint answers discovery and capability requests only: ' +
      'it performs no inference and spends nothing. To run inference or an agent, create a key at ' +
      `${BASE_URL}/api/keys and fund a balance; calls go to ${BASE_URL}/api/v1/chat/completions. ` +
      `Machine-readable capabilities: ${BASE_URL}/api/partner/capabilities. ` +
      `Model catalogue with input and output prices: ${BASE_URL}/api/models/public.`
    const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          id: taskId,
          kind: 'task',
          contextId: String(params?.message?.contextId ?? 'discovery'),
          status: { state: 'completed', timestamp: new Date().toISOString() },
          artifacts: [
            {
              artifactId: `${taskId}-a1`,
              name: 'capabilities',
              parts: [{ kind: 'text', text }],
            },
          ],
        },
      },
    }
  }

  if (method === 'tasks/get') return rpcError(-32001, 'Task not found: this endpoint is stateless')
  return rpcError(-32601, `Method not found: ${String(method)}`)
}

export function registerDiscoveryRoutes(app: Hono<AppEnv>): void {
  app.get('/api/partner/capabilities', (c) => c.json(capabilityCard()))

  app.get('/api/models/public', async (c) => {
    const rows = await query(
      `SELECT model, provider, price_in_1m_usd_micros, price_out_1m_usd_micros
         FROM models_catalog WHERE enabled = true ORDER BY provider, model`
    )
    const data = rows.rows.map((r: any) => {
      const inp = pricePer1m(r.price_in_1m_usd_micros)
      const out = pricePer1m(r.price_out_1m_usd_micros)
      return {
        id: r.model,
        object: 'model',
        owned_by: r.provider,
        pricing: {
          currency: 'usd',
          unit: 'per_1m_tokens',
          input_catalog_usd: inp.catalog_usd,
          output_catalog_usd: out.catalog_usd,
          // What a customer is actually billed, margin included, so nobody has to
          // reconstruct our markup from a surprise on their invoice.
          input_billed_usd: inp.billed_usd,
          output_billed_usd: out.billed_usd,
        },
      }
    })
    return c.json({
      object: 'list',
      data,
      pricing_notes: {
        margin_pct: MARGIN_PCT,
        billed_includes_margin: true,
        byok_discount: 'calls made with your own provider key are billed at 2% of catalogue',
        starter_credit_usd: 0.02,
      },
      source: `${BASE_URL}/api/models/public`,
    })
  })

  // Served at the root by vercel.json rewrites; this alias covers the /api path too.
  app.get('/.well-known/agent-card.json', (c) => c.json(agentCard()))
  app.get('/api/.well-known/agent-card.json', (c) => c.json(agentCard()))

  const a2aHandler = async (c: any) => {
    const body = await c.req.json().catch(() => null)
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid Request' } })
    }
    const out = a2aResponse(body.method, body.params, body.id)
    return c.json(out.body as any, out.status as any)
  }
  app.post('/a2a', a2aHandler)
  app.post('/api/a2a', a2aHandler)
}
