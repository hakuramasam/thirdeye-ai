/**
 * Settlement bookkeeping: state transitions and the append-only event log.
 *
 * Nothing here writes money. Crediting stays in the billing layer, which is idempotent per
 * (chain, tx, token); this module records what happened so a reorg or a partial failure can be
 * audited and resumed instead of guessed at. Ledger history is never deleted.
 *
 * Two rules this module exists to hold:
 *
 *  1. A payment row is identified by its whole uniqueness key, not by chain and tx hash alone.
 *     The same transaction can pay the same token into two different receiving wallets, so a
 *     lookup that ignores `received_by` (or `token`) can read one wallet's state and act on
 *     another's deposit.
 *  2. Every state transition is a guarded UPDATE and its audit event is written inside the same
 *     transaction. A transition that matched no row writes no event, and an event-write failure
 *     rolls the transition back, so `payments.state` and `payment_events` can never disagree.
 */
import { randomBytes } from 'node:crypto'
import { query, tx } from '../db/index.js'
import { CREDITABLE_STATES } from './finality.js'

/** The full uniqueness key of a payment row: what the table's UNIQUE constraint covers. */
export type PaymentRef = {
  chain_id: number
  tx_hash: string
  token: string
  received_by: string
}

/** Normalised so a stored row and an incoming transfer always compare equal. */
function refOf(ref: PaymentRef): [number, string, string, string] {
  return [ref.chain_id, String(ref.tx_hash || '').toLowerCase(), String(ref.token || '').toLowerCase(), String(ref.received_by || '')]
}

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

/** Stored settlement state for exactly this transfer, or null when it was never recorded. */
export async function paymentStateFor(ref: PaymentRef): Promise<string | null> {
  const rows = (
    await query(
      `SELECT state FROM payments
        WHERE chain_id = $1 AND lower(tx_hash) = $2 AND lower(token) = $3 AND received_by = $4
        ORDER BY created_at ASC LIMIT 1`,
      refOf(ref)
    )
  ).rows
  return rows[0]?.state ?? null
}

/** The whole row for exactly this transfer, so a caller can audit what it is about to change. */
export async function paymentRowFor(ref: PaymentRef): Promise<{ id: string; state: string; status: string } | null> {
  const rows = (
    await query(
      `SELECT id, state, status FROM payments
        WHERE chain_id = $1 AND lower(tx_hash) = $2 AND lower(token) = $3 AND received_by = $4
        ORDER BY created_at ASC LIMIT 1`,
      refOf(ref)
    )
  ).rows
  return rows[0] ?? null
}

export type CreditRecord = {
  /** True when this call moved the row into `credited`. */
  credited: boolean
  /** The state the row holds after the call, or null when there was no row to change. */
  state: string | null
  /** True when a credit landed on a deposit the chain has since dropped: a human must reconcile. */
  reconciliation: boolean
}

/**
 * The payment statuses a credit may still be booked against. A `refused` row is a decision that was
 * already made against itself, and a `pending_conversion` row has no money to credit yet, so
 * neither may turn into a credited payment on a later retry.
 */
export const CREDITABLE_STATUSES: readonly string[] = ['recorded', 'pending_confirmations']

/**
 * Record that a deposit's credit was released, and how much, in one transaction.
 *
 * Called only after the money side has already succeeded (or been proven idempotent), so the job
 * here is bookkeeping. The UPDATE is guarded on the states that may still become credited:
 *
 *  - `credited` is excluded, so a replay is a no-op rather than a second event.
 *  - a `refused` or `pending_conversion` status is excluded too: the first is a refusal that a
 *    retry must not overturn, the second has not been converted into a creditable amount.
 *  - `reorged` and `needs_reconciliation` are excluded, so a stale retry cannot overwrite a
 *    finding with a success. A reorg observed before this credit landed, but after the credit
 *    committed, is escalated to `needs_reconciliation` below instead of being silently reversed:
 *    reversing a ledger entry is a financial action reserved for authorized reconciliation.
 *
 * A zero-row UPDATE writes no `credited` event and promotes nothing.
 */
export async function markCredited(
  paymentId: string,
  usdMicros: number
): Promise<CreditRecord> {
  return tx(async (q) => {
    const updated = await q(
      `UPDATE payments
          SET state = 'credited',
              credited_at = COALESCE(credited_at, now()),
              usd_value_micros = CASE WHEN $2::bigint > 0 THEN $2::bigint ELSE usd_value_micros END,
              status = CASE WHEN status = 'pending_confirmations' THEN 'recorded' ELSE status END
        WHERE id = $1
          AND state = ANY($3::text[])
          AND status = ANY($4::text[])
        RETURNING id, state, intent_id`,
      // Both whitelists are passed in from their single definition rather than written into the
      // SQL, so the guard, the verdict and the route cannot drift apart.
      [paymentId, usdMicros, [...CREDITABLE_STATES], [...CREDITABLE_STATUSES]]
    )

    const row = updated.rows[0]
    if (row) {
      await q(`INSERT INTO payment_events (id, payment_id, kind, detail) VALUES ($1, $2, $3, $4)`, [
        'pev_' + randomBytes(9).toString('hex'),
        paymentId,
        'credited',
        JSON.stringify({ usd_micros: usdMicros }),
      ])
      // A row claimed as pending_confirmations had its intent left open by recordPayment, so the
      // credit is where it settles. A row claimed as `recorded` was already marked paid at claim
      // time and this is a no-op; it stays here so the two paths cannot leave an intent open.
      if (row.intent_id) {
        await q(
          `UPDATE payment_intents SET status = 'paid' WHERE id = $1 AND status = 'open'`,
          [row.intent_id]
        )
      }
      return { credited: true, state: 'credited', reconciliation: false }
    }

    // The guard refused. Work out why before reporting, because "nothing happened" is not always
    // the truth: a credit that already landed on a deposit the chain has since dropped is a
    // reconciliation item, not a no-op.
    const current = await q(`SELECT state, intent_id FROM payments WHERE id = $1 FOR UPDATE`, [paymentId])
    const state: string | null = current.rows[0]?.state ?? null
    if (state === 'reorged') {
      await q(`UPDATE payments SET state = 'needs_reconciliation', reconciled_at = now() WHERE id = $1`, [
        paymentId,
      ])
      await q(`INSERT INTO payment_events (id, payment_id, kind, detail) VALUES ($1, $2, $3, $4)`, [
        'pev_' + randomBytes(9).toString('hex'),
        paymentId,
        'reconciliation_required',
        JSON.stringify({ previous_state: 'reorged', usd_micros: usdMicros }),
      ])
      return { credited: false, state: 'needs_reconciliation', reconciliation: true }
    }
    return { credited: false, state, reconciliation: state === 'needs_reconciliation' }
  })
}

/**
 * A transfer we recorded that is no longer on the chain. If it was already credited the money has
 * to be reconciled by a human, because reversing a ledger entry is a financial action, not a
 * retry: the row is moved to needs_reconciliation and the event records what it used to be.
 *
 * Scope matters as much as it does for a credit. (chain, tx) alone can match several rows, because
 * the same transaction can pay the same token into two different receiving wallets, so the caller's
 * scope is applied exactly as given and *every* matching row is reclassified and audited. Picking
 * one with `LIMIT 1` would have let an arbitrary row answer for a transfer it does not describe,
 * and left the others still creditable. Pass `token` and `received_by` to address one deposit.
 *
 * A row already at `needs_reconciliation` keeps that state: it is the stronger finding and a repeat
 * check must not downgrade it to `reorged` and report that nothing was credited.
 */
export type ReorgOutcome = {
  paymentId: string
  state: string
  /** True when this deposit had already been credited (or escalated): a human must reconcile it. */
  wasCredited: boolean
  token: string
  received_by: string
}

export type ReorgReport = {
  /** Every row the scope matched, each with its own audited transition. */
  payments: ReorgOutcome[]
  /** True when any matched deposit had already been credited. */
  wasCredited: boolean
  /** The single matched row's id, or null when the scope matched none or more than one. */
  paymentId: string | null
  /** The single matched row's state, or null when the scope was not that narrow. */
  state: string | null
}

export async function markReorged(
  chainId: number,
  txHash: string,
  scope?: { token?: string; received_by?: string }
): Promise<ReorgReport | null> {
  return tx(async (q) => {
    const params: any[] = [chainId, String(txHash || '').toLowerCase()]
    let where = `chain_id = $1 AND lower(tx_hash) = $2`
    if (scope?.token) {
      params.push(String(scope.token).toLowerCase())
      where += ` AND lower(token) = $${params.length}`
    }
    if (scope?.received_by) {
      params.push(String(scope.received_by))
      where += ` AND received_by = $${params.length}`
    }
    // No LIMIT: the scope decides the set, and every row in it is reclassified. Ordering keeps the
    // audit writes in a stable order so two runs against the same rows produce the same log.
    const found = await q(
      `SELECT id, state, token, received_by FROM payments WHERE ${where} ORDER BY created_at ASC, id ASC FOR UPDATE`,
      params
    )
    if (found.rows.length === 0) return null

    const payments: ReorgOutcome[] = []
    for (const row of found.rows) {
      const wasCredited = row.state === 'credited' || row.state === 'needs_reconciliation'
      const next = wasCredited ? 'needs_reconciliation' : 'reorged'
      if (row.state !== next) {
        await q(`UPDATE payments SET state = $2, reconciled_at = now() WHERE id = $1`, [row.id, next])
        await q(`INSERT INTO payment_events (id, payment_id, kind, detail) VALUES ($1, $2, $3, $4)`, [
          'pev_' + randomBytes(9).toString('hex'),
          row.id,
          'reorg_detected',
          JSON.stringify({ previous_state: row.state, was_credited: wasCredited }),
        ])
      }
      payments.push({
        paymentId: row.id,
        state: next,
        wasCredited,
        token: row.token,
        received_by: row.received_by,
      })
    }

    const single = payments.length === 1 ? payments[0] : null
    return {
      payments,
      wasCredited: payments.some((p) => p.wasCredited),
      paymentId: single?.paymentId ?? null,
      state: single?.state ?? null,
    }
  })
}