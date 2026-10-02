import { adjustCredit, getBalanceMicros } from '../lib/billing.js'
import type { SessionApp } from '../lib/session.js'
import { one } from '../db/index.js'
import { env } from '../lib/env.js'

/** Ops endpoints gated by MASTER_KEY. Used for manual credits (promos, refunds, testing). */
export function registerAdminRoutes(app: SessionApp) {
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
