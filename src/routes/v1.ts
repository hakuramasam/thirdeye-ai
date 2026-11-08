import type { Hono } from 'hono'
import { cors } from 'hono/cors'
import { query } from '../db/index.js'
import { debitForUsage, getBalanceMicros } from '../lib/billing.js'
import { isCovered } from '../lib/allowance.js'
import { env, newId } from '../lib/env.js'
import { apiKeyAuth } from '../lib/keys.js'
import { computeCostMicros } from '../lib/pricing.js'
import { chargeKeyBudget, checkKeyBudget } from '../lib/keybudget.js'
import { chargeCall, getKeyCreditMicros } from '../lib/keycredit.js'
import { adjustCredit } from '../lib/billing.js'
import { checkAndConsume, refundSlot } from '../lib/ratelimit.js'
import type { AppEnv } from '../lib/types.js'
import { recordUsage } from '../lib/usage.js'
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
  app.get('/api/v1/models', apiKeyAuth, async (c) => {
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
  app.post('/api/v1/chat/completions', apiKeyAuth, async (c) => {
    const startTime = Date.now()
    const body = await c.req.json().catch(() => ({}))
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
      try {
        const upstreamRes = await providerCall.stream(body)
        if (!upstreamRes.body) {
          throw new UpstreamError('No stream body received from provider stream', 500)
        }

        let reservedMicros = 0

        const [stream1, stream2] = upstreamRes.body.tee()

        // Background processing of stream2 to parse usage and charge
        const streamTask = (async () => {
          let promptTokens = estTokens
          let completionTokens = 0
          let totalChars = 0
          try {
            let streamUsage: any = null
            const reader = stream2.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed.startsWith('data: ')) {
                  const jsonStr = trimmed.slice(6).trim()
                  if (jsonStr === '[DONE]') continue
                  try {
                    const parsed = JSON.parse(jsonStr)
                    if (parsed.usage) {
                      if (typeof parsed.usage.prompt_tokens === 'number') promptTokens = parsed.usage.prompt_tokens
                      if (typeof parsed.usage.completion_tokens === 'number') completionTokens = parsed.usage.completion_tokens
                      // Keep the provider's own usage object so cache and reasoning tokens survive streaming.
                      streamUsage = parsed.usage
                    }
                    if (parsed.choices?.[0]?.delta?.content) {
                      totalChars += parsed.choices[0].delta.content.length
                    }
                  } catch (_) {}
                }
              }
            }
            if (completionTokens === 0 && totalChars > 0) {
              completionTokens = Math.ceil(totalChars / 4)
            }
            const latencyMs = Date.now() - startTime
            const usage = normalizeUsage(streamUsage, { prompt: promptTokens, completion: completionTokens })
            const costMicros = computeCostMicrosDetailed(
              modelRow,
              usage,
              env.platformMarginPct,
              providerCall.byok
            )
            const deltaMicros = costMicros - reservedMicros
            if (deltaMicros > 0) {
              await chargeCall(apiKey.id, user.id, deltaMicros, 'stream-trueup:' + newId(), {
                allowNegative: await isCovered(user.wallet),
              })
            } else if (deltaMicros < 0) {
              await adjustCredit(user.id, -deltaMicros, 'stream-trueup-refund')
            }
            if (costMicros > 0) await chargeKeyBudget(apiKey, costMicros)
            await recordUsage({
              user_id: user.id,
              api_key_id: apiKey.id,
              model: requestedModel,
              provider: modelRow.provider,
              byok: providerCall.byok,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              input_cached_read: usage.input_cached_read,
              input_cache_write: usage.input_cache_write,
              reasoning_tokens: usage.reasoning_tokens,
              rate_card_version: RATE_CARD_VERSION,
              cost_usd_micros: costMicros,
              status: 'stream',
              latency_ms: latencyMs,
            })
          } catch (e) {
            console.error('Error processing stream tee:', e)
          }
        })()
        // Keep the accounting alive after the response closes. Without this the runtime is
        // free to freeze the function the moment the stream ends, which silently loses the
        // true-up; awaiting as a fallback is slower but never wrong.
        try {
          c.executionCtx.waitUntil(streamTask)
        } catch {
          streamTask.catch(() => {})
        }

        // Reserve an estimate before the first token leaves: if the accounting task never
        // finishes (serverless can end a function once the response closes) the call is still
        // paid for, and the tee trues it up to the real figure.
        if (!providerCall.byok) {
          const est = normalizeUsage(null, { prompt: estTokens, completion: Number(body.max_tokens) || 120 })
          reservedMicros = computeCostMicrosDetailed(modelRow, est, env.platformMarginPct, false)
          if (reservedMicros > 0) {
            const res1 = await chargeCall(apiKey.id, user.id, reservedMicros, 'stream-reserve:' + newId(), {
              allowNegative: await isCovered(user.wallet),
            })
            if (!res1.ok) {
              await refundSlot(apiKey.id, estTokens)
              return c.json({ error: { message: 'Insufficient credits. Top up with USDC on Base.', type: 'billing', code: 402 } }, 402)
            }
          }
        }

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')
        c.header('X-Thirdeye-Model', requestedModel)
        c.header('X-Thirdeye-Byok', providerCall.byok ? 'true' : 'false')
        c.header('X-Thirdeye-Cost-Usd', (reservedMicros / 1e6).toFixed(6))
        c.header('X-RateLimit-Remaining-RPM', String(Math.max(0, apiKey.rpm - rl.rpm_used)))

        return c.body(stream1)
      } catch (err: any) {
        await refundSlot(apiKey.id, estTokens)
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
  })
}
