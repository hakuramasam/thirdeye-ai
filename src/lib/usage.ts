import { query } from '../db/index.js'

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
}

export async function recordUsage(event: UsageEventInput): Promise<void> {
  await query(
    `INSERT INTO usage_events (user_id, api_key_id, model, provider, byok, prompt_tokens, completion_tokens, cost_usd_micros, status, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.user_id,
      event.api_key_id,
      event.model,
      event.provider,
      event.byok,
      event.prompt_tokens,
      event.completion_tokens,
      event.cost_usd_micros,
      event.status,
      event.latency_ms,
    ]
  )
}

export type DailyUsageSeries = {
  day: string
  requests: number
  tokens: number
  cost_usd_micros: number
}

export async function getUserUsageSeries(userId: string, days: number = 14): Promise<DailyUsageSeries[]> {
  const res = await query(
    `SELECT
       created_at::date::text AS day,
       COUNT(*)::int AS requests,
       SUM(prompt_tokens + completion_tokens)::bigint AS tokens,
       SUM(cost_usd_micros)::bigint AS cost_usd_micros
     FROM usage_events
     WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
     GROUP BY created_at::date
     ORDER BY day ASC`,
    [userId, days]
  )

  const map = new Map<string, { requests: number; tokens: number; cost_usd_micros: number }>()
  for (const r of res.rows) {
    map.set(r.day, {
      requests: Number(r.requests ?? 0),
      tokens: Number(r.tokens ?? 0),
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
      series.push({ day: dayStr, requests: 0, tokens: 0, cost_usd_micros: 0 })
    }
  }

  return series
}
