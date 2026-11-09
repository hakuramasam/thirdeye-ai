import { adjustCredit, getBalanceMicros } from '../lib/billing.js'
import type { SessionApp } from '../lib/session.js'
import { one } from '../db/index.js'
import { env } from '../lib/env.js'
import { summarize, loadRates } from '../lib/reconcile.js'
import { decideCredit } from '../lib/creditPolicy.js'
import { creditDeposit } from '../lib/billing.js'
import { CHAINS } from '../payments/chains.js'
import { convertPending } from '../payments/convert.js'
import { settleConversion } from '../lib/settle.js'
import { query } from '../db/index.js'

/** Ops endpoints gated by MASTER_KEY. Used for manual credits (promos, refunds, testing). */
export function registerAdminRoutes(app: SessionApp) {
  /**
   * POST /api/admin/convert — run one conversion pass over pending volatile-token deposits.
   * Each deposit is claimed, swapped from a wallet we can sign for, measured, and settled.
   */
  app.post('/api/admin/convert', async (c) => {
    if (c.req.header('x-master-key') !== env.masterKey) return c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const result = await convertPending({ limit: Number(body?.limit ?? 5) })
    return c.json({ ok: true, ...result })
  })

  /**
   * POST /api/admin/payments/:id/settle — record what a swap actually realised for a
   * pending volatile-token deposit, and release credit for that amount only. This is the
   * hook the conversion executor calls; it is the only way a pending payment becomes credit.
   */
  app.post('/api/admin/payments/:id/settle', async (c) => {
    if (c.req.header('x-master-key') !== env.masterKey) return c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const realised = Math.floor(Number(body?.realised_usd_micros))
    const swapTx = String(body?.swap_tx || '').trim()
    if (!Number.isFinite(realised) || realised < 0) {
      return c.json({ error: { message: 'realised_usd_micros must be a non-negative integer', type: 'invalid_request', code: 400 } }, 400)
    }
    if (!swapTx) return c.json({ error: { message: 'swap_tx is required', type: 'invalid_request', code: 400 } }, 400)

    const p = await one('SELECT * FROM payments WHERE id = $1', [c.req.param('id')])
    if (!p) return c.json({ error: { message: 'Payment not found', type: 'not_found', code: 404 } }, 404)
    if (p.status !== 'pending_conversion') {
      return c.json({ error: { message: `Payment is ${p.status}, not pending_conversion`, type: 'conflict', code: 409 } }, 409)
    }

    const chainSlug = p.chain_slug || 'base'
    const decision = decideCredit({
      chainSlug,
      token: p.token,
      oracleMicros: Number(p.usd_value_micros ?? 0),
      realisedMicros: realised,
    })
    if (decision.status !== 'credited') {
      return c.json({ ok: false, credit_status: decision.status, credit_reason: decision.reason }, 200)
    }

    // Mark first, credit second: a crash between the two leaves the payment claimed for
    // audit rather than silently double-creditable, and the deposit idempotency key
    // (chain + swap tx + settlement token) makes a retry converge.
    const updated = await one(
      `UPDATE payments SET status = 'recorded', realised_usd_micros = $1, settlement_swap_tx = $2 WHERE id = $3 AND status = 'pending_conversion' RETURNING id`,
      [realised, swapTx, p.id]
    )
    if (!updated) return c.json({ error: { message: 'Payment was settled concurrently', type: 'conflict', code: 409 } }, 409)

    const settlement = CHAINS.find((x: any) => x.id === chainSlug)?.settlement
    let toKeyId: string | null = null
    if (p.intent_id) {
      const it = await one('SELECT api_key_id FROM payment_intents WHERE id = $1', [p.intent_id])
      toKeyId = it?.api_key_id ?? null
    }
    const dep = await creditDeposit(p.user_id, decision.creditMicros, {
      chain: chainSlug,
      txHash: swapTx,
      token: settlement?.address ?? 'settlement',
    }, { toKeyId })
    return c.json({
      ok: true,
      credited_usd_micros: decision.creditMicros,
      loaded_to: toKeyId ? 'key' : 'account',
      api_key_id: toKeyId,
      key_credit_usd_micros: (dep as any).keyCredit ?? null,
      balance_usd_micros: dep.balance,
      credit_reason: decision.reason,
    })
  })

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
