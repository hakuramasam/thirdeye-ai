import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { query, one } from '../db/index.js'

function getLastNDaysUTC(n: number): string[] {
  const dates: string[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

export function registerStatsRoutes(app: SessionApp): void {
  // GET /api/stats/me
  app.get('/api/stats/me', requireUser, async (c) => {
    const user = c.get('user')!

    const usageRes = await query(
      `SELECT
        TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS requests,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS tokens,
        COALESCE(SUM(cost_usd_micros), 0)::bigint AS cost_usd_micros
       FROM usage_events
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
       GROUP BY 1`,
      [user.id]
    )

    const depositRes = await query(
      `SELECT
        TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COALESCE(SUM(amount_usd_micros), 0)::bigint AS deposits_usd_micros
       FROM ledger
       WHERE user_id = $1 AND kind = 'deposit' AND created_at >= NOW() - INTERVAL '14 days'
       GROUP BY 1`,
      [user.id]
    )

    const usageMap: Record<string, { requests: number; tokens: number; cost_usd_micros: number }> = {}
    for (const r of usageRes.rows) {
      usageMap[r.day] = {
        requests: Number(r.requests),
        tokens: Number(r.tokens),
        cost_usd_micros: Number(r.cost_usd_micros),
      }
    }

    const depositMap: Record<string, number> = {}
    for (const r of depositRes.rows) {
      depositMap[r.day] = Number(r.deposits_usd_micros)
    }

    const days14 = getLastNDaysUTC(14)
    const series = days14.map((day) => ({
      day,
      requests: usageMap[day]?.requests ?? 0,
      tokens: usageMap[day]?.tokens ?? 0,
      cost_usd_micros: usageMap[day]?.cost_usd_micros ?? 0,
      deposits_usd_micros: depositMap[day] ?? 0,
    }))

    return c.json(series)
  })

  // GET /api/stats/public
  app.get('/api/stats/public', async (c) => {
    const reqsRow = await one(`SELECT COUNT(*)::int AS requests FROM usage_events`)
    const tokensRow = await one(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS tokens FROM usage_events`
    )
    const inflowRow = await one(
      `SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS inflow FROM ledger WHERE kind = 'deposit'`
    )
    const outflowRow = await one(
      `SELECT COALESCE(ABS(SUM(amount_usd_micros)), 0)::bigint AS outflow FROM ledger WHERE amount_usd_micros < 0`
    )
    const usersRow = await one(`SELECT COUNT(*)::int AS users FROM users`)

    const totals = {
      requests: Number(reqsRow?.requests ?? 0),
      tokens: Number(tokensRow?.tokens ?? 0),
      inflow_usd_micros: Number(inflowRow?.inflow ?? 0),
      outflow_usd_micros: Number(outflowRow?.outflow ?? 0),
      users: Number(usersRow?.users ?? 0),
    }

    const usageRes = await query(
      `SELECT
        TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS requests,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS tokens
       FROM usage_events
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1`
    )

    const inflowRes = await query(
      `SELECT
        TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COALESCE(SUM(amount_usd_micros), 0)::bigint AS inflow
       FROM ledger
       WHERE kind = 'deposit' AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1`
    )

    const outflowRes = await query(
      `SELECT
        TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COALESCE(ABS(SUM(amount_usd_micros)), 0)::bigint AS outflow
       FROM ledger
       WHERE amount_usd_micros < 0 AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1`
    )

    const usageMap: Record<string, { requests: number; tokens: number }> = {}
    for (const r of usageRes.rows) {
      usageMap[r.day] = { requests: Number(r.requests), tokens: Number(r.tokens) }
    }

    const inflowMap: Record<string, number> = {}
    for (const r of inflowRes.rows) {
      inflowMap[r.day] = Number(r.inflow)
    }

    const outflowMap: Record<string, number> = {}
    for (const r of outflowRes.rows) {
      outflowMap[r.day] = Number(r.outflow)
    }

    const days30 = getLastNDaysUTC(30)
    const series = days30.map((day) => ({
      day,
      requests: usageMap[day]?.requests ?? 0,
      tokens: usageMap[day]?.tokens ?? 0,
      inflow_usd_micros: inflowMap[day] ?? 0,
      outflow_usd_micros: outflowMap[day] ?? 0,
    }))

    return c.json({ totals, series })
  })
}
