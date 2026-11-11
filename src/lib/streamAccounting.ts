import { adjustCredit } from './billing.js'
import { isCovered } from './allowance.js'
import { newId } from './env.js'
import { chargeCall, creditKey, refundSplit } from './keycredit.js'
import { chargeKeyBudget } from './keybudget.js'
import type { ModelRow } from './pricing.js'
import { computeCostMicrosDetailed } from './pricing.js'
import { normalizeUsage } from './tokenUsage.js'
import type { TokenUsage } from './tokenUsage.js'
import { recordUsage } from './usage.js'

/**
 * Streaming is settled inside the response stream, not in a detached task.
 *
 * The first version of this route tee'd the upstream body and handed the accounting to
 * `c.executionCtx.waitUntil`. The serverless entry (`api/index.ts`) calls `handle(app)` from
 * `hono/vercel`, which invokes `app.fetch(req)` with no ExecutionContext at all, so
 * `c.executionCtx` throws on every request and the accounting fell back to a bare
 * fire-and-forget promise. Vercel is free to freeze the function the moment the response
 * completes, which it does, so the true-up was written only when the runtime happened to keep
 * the invocation alive: the reserve stayed on the books and the measured cost never replaced
 * it. That is the 45% streaming undercharge in docs/development-assessment-2026-11-09.md.
 *
 * Now the accounting is a TransformStream the response is made of, so the stream cannot close
 * before the settlement resolves: the client reading to the end is itself the proof the call
 * was priced. If the client hangs up early, `cancel` settles against what was actually
 * measured rather than leaving the reserve to stand alone.
 */

export type StreamAccountingOptions = {
  userId: string
  wallet: string
  apiKey: any
  modelRow: ModelRow
  requestedModel: string
  provider: string
  byok: boolean
  marginPct: number
  /** Tokens our own request estimate says we sent, used until the provider reports its own. */
  estTokens: number
  /** Charged before the first token leaves. The true-up compares against this exact figure. */
  reservedMicros: number
  /** How much of the reserve came out of key-scoped credit, so a refund goes back the same way. */
  reservedFromKey: number
  startedAt: number
  rateCardVersion: string
}

export type StreamSettlement = {
  prompt_tokens: number
  completion_tokens: number
  cost_usd_micros: number
  delta_micros: number
  /** `provider` when the upstream reported usage, `chars` when we had to infer it. */
  usage_source: 'provider' | 'chars' | 'estimate'
  settled: boolean
}

export type StreamAccountant = {
  transform: TransformStream<Uint8Array, Uint8Array>
  /** Resolves once settlement finished. The route does not need it; tests do. */
  done: Promise<StreamSettlement>
}

export function createStreamAccountant(opts: StreamAccountingOptions): StreamAccountant {
  const decoder = new TextDecoder()
  let promptTokens = opts.estTokens
  let completionTokens = 0
  let totalChars = 0
  let streamUsage: any = null
  let buffer = ''
  let settled = false

  let resolveDone!: (s: StreamSettlement) => void
  const done = new Promise<StreamSettlement>((resolve) => {
    resolveDone = resolve
  })

  const consume = (text: string): void => {
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) parseLine(line)
  }

  const parseLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data: ')) return
    const jsonStr = trimmed.slice(6).trim()
    if (jsonStr === '[DONE]') return
    try {
      const parsed = JSON.parse(jsonStr)
      if (parsed.usage) {
        if (typeof parsed.usage.prompt_tokens === 'number') promptTokens = parsed.usage.prompt_tokens
        if (typeof parsed.usage.completion_tokens === 'number') completionTokens = parsed.usage.completion_tokens
        // Keep the provider's own usage object so cache and reasoning tokens survive streaming.
        streamUsage = parsed.usage
      }
      if (parsed.choices?.[0]?.delta?.content) {
        totalChars += String(parsed.choices[0].delta.content).length
      }
    } catch {
      // A partial or non-JSON line is not an accounting failure; the next chunk completes it.
    }
  }

  const usageSource = (): StreamSettlement['usage_source'] => {
    if (streamUsage) return 'provider'
    return totalChars > 0 ? 'chars' : 'estimate'
  }

  const usageWithFallback = (): TokenUsage => {
    if (!streamUsage && completionTokens === 0 && totalChars > 0) {
      completionTokens = Math.ceil(totalChars / 4)
    }
    return normalizeUsage(streamUsage, { prompt: promptTokens, completion: completionTokens })
  }

  const settle = async (): Promise<StreamSettlement> => {
    const usage = usageWithFallback()
    const result: StreamSettlement = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cost_usd_micros: 0,
      delta_micros: -opts.reservedMicros,
      usage_source: usageSource(),
      settled: false,
    }
    if (settled) {
      result.settled = true
      result.cost_usd_micros = opts.reservedMicros
      result.delta_micros = 0
      return result
    }
    settled = true

    const costMicros = computeCostMicrosDetailed(opts.modelRow, usage, opts.marginPct, opts.byok)
    const deltaMicros = costMicros - opts.reservedMicros
    result.cost_usd_micros = costMicros
    result.delta_micros = deltaMicros

    try {
      if (deltaMicros > 0) {
        await chargeCall(opts.apiKey.id, opts.userId, deltaMicros, 'stream-trueup:' + newId(), {
          allowNegative: await isCovered(opts.wallet),
        })
      } else if (deltaMicros < 0) {
        // Refund along the same split the reserve used, or the key stays overcharged while
        // the account is credited money it never spent.
        const refund = refundSplit(-deltaMicros, opts.reservedFromKey)
        if (refund.toKey > 0) await creditKey(opts.apiKey.id, refund.toKey)
        if (refund.toAccount > 0) await adjustCredit(opts.userId, refund.toAccount, 'stream-trueup-refund')
      }
      if (costMicros > 0) await chargeKeyBudget(opts.apiKey, costMicros)
      await recordUsage({
        user_id: opts.userId,
        api_key_id: opts.apiKey.id,
        model: opts.requestedModel,
        provider: opts.provider,
        byok: opts.byok,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        input_cached_read: usage.input_cached_read,
        input_cache_write: usage.input_cache_write,
        reasoning_tokens: usage.reasoning_tokens,
        rate_card_version: opts.rateCardVersion,
        cost_usd_micros: costMicros,
        status: 'stream',
        latency_ms: Date.now() - opts.startedAt,
      })
      result.settled = true
      // One line per settled stream in the runtime logs, so the true-up can be observed on
      // production without reaching into the database.
      console.log('stream_settled', {
        model: opts.requestedModel,
        cost_micros: costMicros,
        reserved_micros: opts.reservedMicros,
        delta_micros: deltaMicros,
        usage_source: result.usage_source,
      })
    } catch (err: any) {
      // The reserve already stands, so the call is never free. Record that the true-up was
      // lost instead of pretending the figure on the books is measured.
      console.error('stream settlement failed', { error: err?.message, usage_source: result.usage_source })
      try {
        await recordUsage({
          user_id: opts.userId,
          api_key_id: opts.apiKey.id,
          model: opts.requestedModel,
          provider: opts.provider,
          byok: opts.byok,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          rate_card_version: opts.rateCardVersion,
          cost_usd_micros: opts.reservedMicros,
          status: 'stream_settle_error',
          latency_ms: Date.now() - opts.startedAt,
        })
      } catch {
        /* the caller still gets its tokens; nothing else here can help */
      }
    }
    resolveDone(result)
    return result
  }

  // `cancel` is part of the TransformStream spec but missing from this TypeScript lib's
  // Transformer type, so the object is cast rather than losing the early-hangup settlement.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      // Pass the bytes through untouched before doing any accounting work, so parsing can
      // never delay a token.
      controller.enqueue(chunk)
      try {
        consume(decoder.decode(chunk, { stream: true }))
      } catch {
        /* accounting is best-effort per chunk; settlement uses whatever was parsed */
      }
    },
    async flush() {
      if (buffer) parseLine(buffer)
      await settle()
    },
    async cancel() {
      if (buffer) parseLine(buffer)
      await settle()
    },
  } as any)

  return { transform, done }
}
