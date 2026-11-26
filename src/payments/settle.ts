/**
 * Settlement bookkeeping: state transitions and the append-only event log.
 *
 * Nothing here writes money. Crediting stays in the billing layer, which is idempotent per
 * (chain, tx, token); this module records what happened so a reorg or a partial failure can be
 * audited and resumed instead of guessed at. Ledger history is never deleted.
 */
import { randomBytes } from 'node:crypto'
import { query } from '../db/index.js'

export async function logPaymentEvent(
  paymentId: string,
  kind: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `INSERT INTO payment_events (id, payment_id, kind, detail) VALUES ($1, $2, $3, $4)`,
    ['pev_' + randomBytes(9).toString('hex'), paymentId, kind, JSON.stringify(detail)]
  )
}

/** Stored settlement state for a transfer, or null when it was never recorded. */
export async function paymentStateFor(transfer: {
  chain_id: number
  tx_hash: string
  token: string
}): Promise<string | null> {
  const rows = (
    await query(
      `SELECT state FROM payments
        WHERE chain_id = $1 AND tx_hash = $2 AND token = $3
        ORDER BY created_at ASC LIMIT 1`,
      [transfer.chain_id, transfer.tx_hash, transfer.token]
    )
  ).rows
  return rows[0]?.state ?? null
}

/** Record that a deposit's credit was released, and how much. */
export async function markCredited(paymentId: string, usdMicros: number): Promise<void> {
  await query(
    `UPDATE payments
        SET state = 'credited',
            credited_at = COALESCE(credited_at, now()),
            usd_value_micros = CASE WHEN $2 > 0 THEN $2 ELSE usd_value_micros END
      WHERE id = $1`,
    [paymentId, usdMicros]
  )
  await logPaymentEvent(paymentId, 'credited', { usd_micros: usdMicros })
}

/**
 * A transfer we recorded that is no longer on the chain. If it was already credited the money has
 * to be reconciled by a human, because reversing a ledger entry is a financial action, not a
 * retry: the row is moved to needs_reconciliation and the event records what it used to be.
 */
export async function markReorged(
  chainId: number,
  txHash: string
): Promise<{ paymentId: string; wasCredited: boolean } | null> {
  const rows = (
    await query(
      `SELECT id, state FROM payments
        WHERE chain_id = $1 AND tx_hash = $2
        ORDER BY created_at ASC LIMIT 1`,
      [chainId, txHash.toLowerCase()]
    )
  ).rows
  const row = rows[0]
  if (!row) return null
  const wasCredited = row.state === 'credited'
  await query(`UPDATE payments SET state = $2, reconciled_at = now() WHERE id = $1`, [
    row.id,
    wasCredited ? 'needs_reconciliation' : 'reorged',
  ])
  await logPaymentEvent(row.id, 'reorg_detected', {
    previous_state: row.state,
    was_credited: wasCredited,
  })
  return { paymentId: row.id, wasCredited }
}
