import { one, query, tx } from '../db/index.js'
import { newId } from './env.js'

/**
 * Prepaid credit ledger. All amounts are signed USD micros.
 * Inflow (deposits) and outflow (usage spend) recorded here — this is also the
 * source for the /api/stats tokenized-stocks feed.
 */

export async function getBalanceMicros(userId: string): Promise<number> {
  const r = await one('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
  return Number(r?.bal ?? 0)
}

/** Charge a request. Returns ok:false when the balance is insufficient. */
export async function debitForUsage(userId: string, costMicros: number, ref: string): Promise<{ ok: boolean; balance: number }> {
  if (costMicros <= 0) return { ok: true, balance: await getBalanceMicros(userId) }
  return tx(async (q) => {
    // Serialize per-user debits
    await q('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
    const b = await q('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
    const balance = Number(b.rows[0]?.bal ?? 0)
    if (balance < costMicros) return { ok: false, balance }
    await q('INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)', [userId, -costMicros, 'usage', ref])
    return { ok: true, balance: balance - costMicros }
  })
}

/** Credit a verified on-chain deposit. Idempotent per (chain, txHash, token). */
export async function creditDeposit(
  userId: string,
  amountMicros: number,
  ref: { chain: string; txHash: string; token: string }
): Promise<{ credited: boolean; balance: number }> {
  return tx(async (q) => {
    await q('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
    const dep = await q(
      `INSERT INTO deposits (id, user_id, chain, token, tx_hash, amount_usd_micros)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chain, tx_hash, token) DO NOTHING RETURNING id`,
      [newId(), userId, ref.chain, ref.token.toLowerCase(), ref.txHash.toLowerCase(), amountMicros]
    )
    if (!dep.rows[0]) {
      const b = await q('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
      return { credited: false, balance: Number(b.rows[0]?.bal ?? 0) }
    }
    await q('INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)', [
      userId, amountMicros, 'deposit', `${ref.chain}:${ref.txHash}`,
    ])
    const b = await q('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
    return { credited: true, balance: Number(b.rows[0]?.bal ?? 0) }
  })
}

export async function adjustCredit(userId: string, amountMicros: number, reason: string): Promise<void> {
  await query('INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)', [
    userId, amountMicros, 'adjust', reason,
  ])
}
