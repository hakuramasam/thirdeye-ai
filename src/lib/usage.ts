import { query } from '../db/index.js'

/** Shared aggregation used by user, public and library usage reports. */
export const USAGE_TOKEN_BUCKETS_SQL = `COALESCE(SUM(prompt_tokens + completion_tokens + estimated_prompt_tokens + estimated_completion_tokens), 0)::bigint AS tokens,
       COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN prompt_tokens + completion_tokens ELSE 0 END), 0)::bigint AS provider_reported_tokens,
       COALESCE(SUM(CASE WHEN usage_source = 'mock' THEN prompt_tokens + completion_tokens ELSE 0 END), 0)::bigint AS mock_tokens,
       COALESCE(SUM(CASE WHEN usage_source IN ('estimate', 'chars') THEN estimated_prompt_tokens + estimated_completion_tokens ELSE 0 END), 0)::bigint AS estimated_tokens,
       COALESCE(SUM(CASE WHEN usage_source = 'unknown' THEN prompt_tokens + completion_tokens ELSE 0 END), 0)::bigint AS unclassified_tokens`

export type UsageEventInput = {
  user_id: string
  api_key_id: string
  model: string
  provider: string
  byok: boolean
  prompt_tokens: number
  completion_tokens: number
  cost_usd_micros: number
  status: string
  latency_ms: number
  input_cached_read?: number
  input_cache_write?: number
  reasoning_tokens?: number
  rate_card_version?: string | null
  provider_request_id?: string | null
  /** provider = exact upstream counts; estimate/chars = inferred counts; unknown = legacy row. */
  usage_source?: 'provider' | 'mock' | 'estimate' | 'chars' | 'none' | 'unknown'
  estimated_prompt_tokens?: number
  estimated_completion_tokens?: number
}

export async function recordUsage(event: UsageEventInput): Promise<void> {
  await query(
    `INSERT INTO usage_events (user_id, api_key_id, model, provider, byok, prompt_tokens, completion_tokens, estimated_prompt_tokens, estimated_completion_tokens, usage_source, cost_usd_micros, status, latency_ms, input_cached_read, input_cache_write, reasoning_tokens, rate_card_version, provider_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      event.user_id,
      event.api_key_id,
      event.model,
      event.provider,
      event.byok,
      event.prompt_tokens,
      event.completion_tokens,
      event.estimated_prompt_tokens ?? 0,
      event.estimated_completion_tokens ?? 0,
      event.usage_source ?? 'unknown',
      event.cost_usd_micros,
      event.status,
      event.latency_ms,
      event.input_cached_read ?? 0,
      event.input_cache_write ?? 0,
      event.reasoning_tokens ?? 0,
      event.rate_card_version ?? null,
      event.provider_request_id ?? null,
    ]
  )
}

export type DailyUsageSeries = {
  day: string
  requests: number
  tokens: number
  provider_reported_tokens: number
  mock_tokens: number
  estimated_tokens: number
  unclassified_tokens: number
  cost_usd_micros: number
}

export async function getUserUsageSeries(userId: string, days: number = 14): Promise<DailyUsageSeries[]> {
  const res = await query(
    `SELECT
       created_at::date::text AS day,
       COUNT(*)::int AS requests,
       ${USAGE_TOKEN_BUCKETS_SQL},
       SUM(cost_usd_micros)::bigint AS cost_usd_micros
     FROM usage_events
     WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
     GROUP BY created_at::date
     ORDER BY day ASC`,
    [userId, days]
  )

  const map = new Map<string, { requests: number; tokens: number; provider_reported_tokens: number; mock_tokens: number; estimated_tokens: number; unclassified_tokens: number; cost_usd_micros: number }>()
  for (const r of res.rows) {
    map.set(r.day, {
      requests: Number(r.requests ?? 0),
      tokens: Number(r.tokens ?? 0),
      provider_reported_tokens: Number(r.provider_reported_tokens ?? 0),
      mock_tokens: Number(r.mock_tokens ?? 0),
      estimated_tokens: Number(r.estimated_tokens ?? 0),
      unclassified_tokens: Number(r.unclassified_tokens ?? 0),
      cost_usd_micros: Number(r.cost_usd_micros ?? 0),
    })
  }

  const series: DailyUsageSeries[] = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dayStr = d.toISOString().slice(0, 10)
    const existing = map.get(dayStr)
    if (existing) {
      series.push({ day: dayStr, ...existing })
    } else {
      series.push({ day: dayStr, requests: 0, tokens: 0, provider_reported_tokens: 0, mock_tokens: 0, estimated_tokens: 0, unclassified_tokens: 0, cost_usd_micros: 0 })
    }
  }

  return series
}
