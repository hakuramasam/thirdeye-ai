import type { Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { query } from '../db/index.js'
import { debitForUsage, getBalanceMicros } from '../lib/billing.js'
import { isCovered } from '../lib/allowance.js'
import { env, newId } from '../lib/env.js'
import { apiKeyAuth } from '../lib/keys.js'
import { computeCostMicros } from '../lib/pricing.js'
import { chargeKeyBudget, checkKeyBudget } from '../lib/keybudget.js'
import { chargeCall, creditKey, getKeyCreditMicros, refundSplit, splitKeyCredit } from '../lib/keycredit.js'
import { adjustCredit } from '../lib/billing.js'
import { checkAndConsume, refundSlot } from '../lib/ratelimit.js'
import type { AppEnv } from '../lib/types.js'
import { recordUsage } from '../lib/usage.js'
import { createStreamAccountant } from '../lib/streamAccounting.js'
import { normalizeUsage } from '../lib/tokenUsage.js'
import { computeCostMicrosDetailed } from '../lib/pricing.js'

/** Bumped when catalogue prices change, so historical rows stay explainable. */
const RATE_CARD_VERSION = process.env.RATE_CARD_VERSION || 'catalog-2026-11'
import { getModelRow, resolveProvider, UpstreamError } from '../providers/index.js'

export function registerV1Routes(app: Hono<AppEnv>): void {
  // CORS middleware for /api/v1/*
  app.use(
    '/api/v1/*',
    cors({
      origin: '*',
      allowHeaders: ['*'],
      allowMethods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
    })
  )

  // GET /api/v1/models
  app.get('/api/v1/models', apiKeyAuth(), async (c) => {
    const res = await query('SELECT * FROM models_catalog WHERE enabled = true')
    const data = res.rows.map((row: any) => ({
      id: row.model,
      object: 'model',
      created: 1700000000,
      owned_by: 'thirdeye-ai',
      owned_by_upstream: row.provider,
      pricing: {
        prompt: (Number(row.price_in_1m_usd_micros) / 1e6).toString(),
        completion: (Number(row.price_out_1m_usd_micros) / 1e6).toString(),
      },
    }))
    return c.json({ object: 'list', data })
  })

  // POST /api/v1/chat/completions
  app.post('/api/v1/chat/completions', apiKeyAuth(), chatCompletionsHandler)
}

/**
 * OpenAI-compatible chat completion.
 *
 * Exported rather than inlined so the Antseed relay route can reuse the exact same billing,
 * rate-limit, budget and cost-header path. A second copy would drift, and the drift would be
 * invisible until someone was charged wrongly.
 */
export async function chatCompletionsHandler(c: Context<AppEnv>) {
  const startTime = Date.now()
  const body = c.get('chatBody') ?? (await c.req.json().catch(() => ({})))
  const requestedModel = body.model
  const messages = body.messages

  if (!requestedModel || !messages) {
    return c.json(
      { error: { message: 'Missing model or messages in request body.', type: 'invalid_request', code: 400 } },
      400
    )
  }

  // 1. Validate model
  const modelRow = await getModelRow(requestedModel)
  if (!modelRow || !modelRow.enabled) {
    return c.json(
      { error: { message: `Model '${requestedModel}' not found or disabled.`, type: 'not_found', code: 404 } },
      404
    )
  }

  const apiKey = c.get('apiKey')!
  const user = c.get('user')!
  const estTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4))

  // 2. Rate limiting check
  const rl = await checkAndConsume(apiKey.id, apiKey.rpm, apiKey.tpm, estTokens)
  if (!rl.ok) {
    c.header('X-RateLimit-Remaining-RPM', String(Math.max(0, apiKey.rpm - rl.rpm_used)))
    c.header('Retry-After', String(rl.reset_seconds))
    return c.json(
      { error: { message: 'Rate limit exceeded. Please retry later.', type: 'rate_limit', code: 429 } },
      429
    )
  }

  // 3. Resolve provider
  let providerCall
  try {
    providerCall = await resolveProvider(user, modelRow)
  } catch (err: any) {
    await refundSlot(apiKey.id, estTokens)
    const status = err instanceof UpstreamError ? err.status : 500
    const payload =
      err instanceof UpstreamError
        ? err.payload
        : { error: { message: err.message || 'Resolution error', type: 'upstream', code: status } }
    await recordUsage({
      user_id: user.id,
      api_key_id: apiKey.id,
      model: requestedModel,
      provider: modelRow.provider,
      byok: false,
      prompt_tokens: estTokens,
      completion_tokens: 0,
      cost_usd_micros: 0,
      status: String(status),
      latency_ms: Date.now() - startTime,
    })
    return c.json(payload, status as any)
  }

  // 4. Balance check for brokered non-zero price calls
  const isFreeModel = Number(modelRow.price_in_1m_usd_micros) === 0 && Number(modelRow.price_out_1m_usd_micros) === 0
  if (!providerCall.byok && !isFreeModel) {
    const balance = await getBalanceMicros(user.id)
    // Key-scoped credit counts as available funds for this key.
    const keyCredit = await getKeyCreditMicros(apiKey.id)
    const available = balance + keyCredit
    // A founder/partner allowance removes the refusal but never mints credit.
    const covered = available < 10000 ? await isCovered(user.wallet) : false
    if (available < 10000 && !covered) {
      await refundSlot(apiKey.id, estTokens)
      return c.json(
        {
          error: {
            message: 'Insufficient credits. Top up with USDC on Base or USDG on Robinhood Chain in the dashboard.',
            type: 'billing',
            code: 402,
          },
        },
        402
      )
    }
  }

  // 4b. Per-key monthly budget cap
  const budget = await checkKeyBudget(apiKey)
  if (budget.exhausted) {
    await refundSlot(apiKey.id, estTokens)
    return c.json(
      {
        error: {
          message: `Monthly budget for this API key is used up ($${(budget.spent / 1e6).toFixed(4)} of $${((budget.cap ?? 0) / 1e6).toFixed(2)}). Raise the key budget or wait for the next period.`,
          type: 'billing',
          code: 'budget_exceeded',
        },
      },
      402
    )
  }

  // 5. Execution
  if (body.stream) {
    // Reserve before the first token leaves, and before the upstream is even called, so the
    // true-up always compares against a known figure. Under the old order (tee first, reserve
    // after) a fast provider could settle while reservedMicros was still 0 and bill twice.
    let reservedMicros = 0
    let reservedFromKey = 0
    if (!providerCall.byok) {
      const est = normalizeUsage(null, { prompt: estTokens, completion: Number(body.max_tokens) || 120 })
      reservedMicros = computeCostMicrosDetailed(modelRow, est, env.platformMarginPct, false)
      if (reservedMicros > 0) {
        const keyCreditBeforeReserve = await getKeyCreditMicros(apiKey.id)
        reservedFromKey = splitKeyCredit(keyCreditBeforeReserve, reservedMicros).fromKey
        const reserve = await chargeCall(apiKey.id, user.id, reservedMicros, 'stream-reserve:' + newId(), {
          allowNegative: await isCovered(user.wallet),
        })
        if (!reserve.ok) {
          await refundSlot(apiKey.id, estTokens)
          return c.json({ error: { message: 'Insufficient credits. Top up with USDC on Base.', type: 'billing', code: 402 } }, 402)
        }
      }
    }

    try {
      const upstreamRes = await providerCall.stream(body)
      if (!upstreamRes.body) {
        throw new UpstreamError('No stream body received from provider stream', 500)
      }

      // The response is the accountant. Settlement runs in the stream's flush, so the runtime
      // cannot end the invocation before the true-up lands. `c.executionCtx` is never used:
      // hono/vercel's handle() calls app.fetch(req) with no ExecutionContext, so it throws.
      const accountant = createStreamAccountant({
        userId: user.id,
        wallet: user.wallet,
        apiKey,
        modelRow,
        requestedModel,
        provider: modelRow.provider,
        byok: providerCall.byok,
        marginPct: env.platformMarginPct,
        estTokens,
        reservedMicros,
        reservedFromKey,
        startedAt: startTime,
        rateCardVersion: RATE_CARD_VERSION,
      })

      c.header('Content-Type', 'text/event-stream')
      c.header('Cache-Control', 'no-cache')
      c.header('Connection', 'keep-alive')
      c.header('X-Thirdeye-Model', requestedModel)
      c.header('X-Thirdeye-Byok', providerCall.byok ? 'true' : 'false')
      c.header('X-Thirdeye-Cost-Usd', (reservedMicros / 1e6).toFixed(6))
      // A stream cannot know its final cost before its last token, so say what this number is.
      c.header('X-Thirdeye-Cost-Basis', 'estimate')
      c.header('X-Thirdeye-Key-Credit-Remaining-Usd', ((await getKeyCreditMicros(apiKey.id)) / 1e6).toFixed(6))
      c.header('X-RateLimit-Remaining-RPM', String(Math.max(0, apiKey.rpm - rl.rpm_used)))

      return c.body(upstreamRes.body.pipeThrough(accountant.transform) as any)
    } catch (err: any) {
      await refundSlot(apiKey.id, estTokens)
      // Nothing streamed, so the reserve comes back rather than becoming a charge for a call
      // that never happened.
      if (reservedMicros > 0) {
        const refund = refundSplit(reservedMicros, reservedFromKey)
        if (refund.toKey > 0) await creditKey(apiKey.id, refund.toKey)
        if (refund.toAccount > 0) await adjustCredit(user.id, refund.toAccount, 'stream-reserve-refund')
      }
      const status = err instanceof UpstreamError ? err.status : 500
      const payload =
        err instanceof UpstreamError
          ? err.payload
          : { error: { message: err.message || 'Stream error', type: 'upstream', code: status } }
      await recordUsage({
        user_id: user.id,
        api_key_id: apiKey.id,
        model: requestedModel,
        provider: modelRow.provider,
        byok: providerCall.byok,
        prompt_tokens: estTokens,
        completion_tokens: 0,
        cost_usd_micros: 0,
        status: String(status),
        latency_ms: Date.now() - startTime,
      })
      return c.json(payload, status as any)
    }
  } else {
    try {
      const res = await providerCall.call(body)
      const latencyMs = Date.now() - startTime
      const usage = normalizeUsage(res.raw?.usage, { prompt: res.prompt_tokens, completion: res.completion_tokens })
      const pt = usage.prompt_tokens
      const ct = usage.completion_tokens
      const costMicros = computeCostMicrosDetailed(modelRow, usage, env.platformMarginPct, providerCall.byok)
      const chatId = 'chatcmpl-thirdeye-' + newId()
      const created = Math.floor(Date.now() / 1000)

      if (costMicros > 0) {
        const debit = await chargeCall(apiKey.id, user.id, costMicros, 'req:' + chatId, {
          allowNegative: await isCovered(user.wallet),
        })
        if (!debit.ok) {
          await refundSlot(apiKey.id, estTokens)
          return c.json(
            {
              error: {
                message: 'Insufficient credits. Top up with USDC on Base or USDG on Robinhood Chain in the dashboard.',
                type: 'billing',
                code: 402,
              },
            },
            402
          )
        }
        await chargeKeyBudget(apiKey, costMicros)
      }

      await recordUsage({
        user_id: user.id,
        api_key_id: apiKey.id,
        model: requestedModel,
        provider: modelRow.provider,
        byok: providerCall.byok,
        prompt_tokens: pt,
        completion_tokens: ct,
        input_cached_read: usage.input_cached_read,
        input_cache_write: usage.input_cache_write,
        reasoning_tokens: usage.reasoning_tokens,
        rate_card_version: RATE_CARD_VERSION,
        provider_request_id: (res.raw as any)?.id ?? null,
        cost_usd_micros: costMicros,
        status: '200',
        latency_ms: latencyMs,
      })

      c.header('X-Thirdeye-Key-Credit-Remaining-Usd', ((await getKeyCreditMicros(apiKey.id)) / 1e6).toFixed(6))
      c.header('X-Thirdeye-Model', requestedModel)
      c.header('X-Thirdeye-Byok', providerCall.byok ? 'true' : 'false')
      c.header('X-Thirdeye-Cost-Usd', (costMicros / 1e6).toFixed(6))
      if (budget.cap != null) {
        c.header('X-Thirdeye-Key-Budget-Remaining-Usd', (Math.max(0, budget.remaining - costMicros) / 1e6).toFixed(6))
      }
      c.header('X-RateLimit-Remaining-RPM', String(Math.max(0, apiKey.rpm - rl.rpm_used)))

      return c.json({
        id: chatId,
        object: 'chat.completion',
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: res.content,
              ...(res.tool_calls ? { tool_calls: res.tool_calls } : {}),
            },
            finish_reason: res.tool_calls?.length ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: pt,
          completion_tokens: ct,
          input_cached_read: usage.input_cached_read,
          input_cache_write: usage.input_cache_write,
          reasoning_tokens: usage.reasoning_tokens,
          rate_card_version: RATE_CARD_VERSION,
          provider_request_id: (res.raw as any)?.id ?? null,
          total_tokens: pt + ct,
        },
      })
    } catch (err: any) {
      await refundSlot(apiKey.id, estTokens)
      const status = err instanceof UpstreamError ? err.status : 500
      const payload =
        err instanceof UpstreamError
          ? err.payload
          : { error: { message: err.message || 'Execution error', type: 'upstream', code: status } }
      await recordUsage({
        user_id: user.id,
        api_key_id: apiKey.id,
        model: requestedModel,
        provider: modelRow.provider,
        byok: providerCall.byok,
        prompt_tokens: estTokens,
        completion_tokens: 0,
        cost_usd_micros: 0,
        status: String(status),
        latency_ms: Date.now() - startTime,
      })
      return c.json(payload, status as any)
    }
  }
}
