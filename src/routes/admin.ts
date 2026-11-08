import { adjustCredit, getBalanceMicros } from '../lib/billing.js'
import type { SessionApp } from '../lib/session.js'
import { one } from '../db/index.js'
import { env } from '../lib/env.js'
import { summarize, loadRates } from '../lib/reconcile.js'
import { query } from '../db/index.js'

/** Ops endpoints gated by MASTER_KEY. Used for manual credits (promos, refunds, testing). */
export function registerAdminRoutes(app: SessionApp) {
  /**
   * POST /api/admin/reconcile — rebuild every charged row from stored tokens and the rate
   * card, and report anything we cannot reproduce. Ops only.
   */
  app.post('/api/admin/reconcile', async (c) => {
    if (c.req.header('x-master-key') !== env.masterKey) return c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const hours = Math.min(Math.max(Number(body?.hours ?? 24), 1), 24 * 90)
    const rows = await query(
      `SELECT model, prompt_tokens, completion_tokens, input_cached_read, input_cache_write,
              cost_usd_micros, rate_card_version, status
         FROM usage_events
        WHERE created_at > now() - ($1 || ' hours')::interval
        ORDER BY created_at DESC`,
      [String(hours)]
    )
    const rates = await loadRates()
    const report = summarize(rows.rows as any, rates, env.platformMarginPct)
    return c.json({ ok: true, window_hours: hours, rate_card_version: process.env.RATE_CARD_VERSION || 'catalog-2026-11', ...report })
  })

  app.post('/api/admin/credit', async (c) => {
    if (c.req.header('x-master-key') !== env.masterKey) return c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
    const body = await c.req.json().catch(() => null)
    const wallet = String(body?.wallet || '').toLowerCase()
    const amount = Math.floor(Number(body?.amount_usd_micros))
    const reason = String(body?.reason || 'manual-credit').slice(0, 120)
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000_000) {
      return c.json({ error: { message: 'Invalid wallet or amount_usd_micros', type: 'invalid', code: 400 } }, 400)
    }
    const user = await one('SELECT id FROM users WHERE wallet = $1', [wallet])
    if (!user) return c.json({ error: { message: 'User not found (must sign in first)', type: 'invalid', code: 404 } }, 404)
    await adjustCredit(user.id, amount, reason)
    return c.json({ ok: true, wallet, credited_usd_micros: amount, balance_usd_micros: await getBalanceMicros(user.id) })
  })
}
