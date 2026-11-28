import { tx } from '../db/index.js'

export const STAGING_SHARED_BUDGET_CAP_MICROS = 67_000

export type BudgetResult = { ok: boolean; replayed?: boolean; reason?: string; reserved_usd_micros?: number; spent_usd_micros?: number }

/**
 * Atomically reserve against the one dispatch-wide ledger. The dispatch row is locked first,
 * so concurrent HERMES/QA/SENTINEL reservations serialize on the same cap.
 */
export async function reserveSharedBudget(
  dispatchId: string,
  reservationId: string,
  amountMicros: number
): Promise<BudgetResult> {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
    return { ok: false, reason: 'invalid_reservation' }
  }
  return tx(async (q) => {
    const dispatch = await q(
      `SELECT id, status, budget_cap_usd_micros, reserved_usd_micros, spent_usd_micros
         FROM staging_agent_dispatches WHERE id = $1 FOR UPDATE`,
      [dispatchId]
    )
    const row = dispatch.rows[0]
    if (!row || row.status !== 'running') return { ok: false, reason: 'dispatch_not_running' }

    const prior = await q(
      `SELECT amount_usd_micros, status FROM staging_agent_budget_reservations
        WHERE dispatch_id = $1 AND reservation_id = $2`,
      [dispatchId, reservationId]
    )
    if (prior.rows[0]) {
      const same = Number(prior.rows[0].amount_usd_micros) === amountMicros
      return same && prior.rows[0].status === 'reserved'
        ? { ok: true, replayed: true, reserved_usd_micros: Number(row.reserved_usd_micros), spent_usd_micros: Number(row.spent_usd_micros) }
        : { ok: false, reason: 'reservation_id_reused' }
    }

    const cap = Number(row.budget_cap_usd_micros)
    const reserved = Number(row.reserved_usd_micros)
    const spent = Number(row.spent_usd_micros)
    if (!Number.isSafeInteger(cap) || reserved + spent + amountMicros > cap) {
      return { ok: false, reason: 'aggregate_budget_exceeded', reserved_usd_micros: reserved, spent_usd_micros: spent }
    }

    await q(
      `UPDATE staging_agent_dispatches SET reserved_usd_micros = reserved_usd_micros + $2
        WHERE id = $1 AND status = 'running'`,
      [dispatchId, amountMicros]
    )
    await q(
      `INSERT INTO staging_agent_budget_reservations
        (id, dispatch_id, reservation_id, amount_usd_micros, status)
        VALUES ($1, $2, $3, $4, 'reserved')`,
      [`sbr_${dispatchId}_${reservationId}`, dispatchId, reservationId, amountMicros]
    )
    return { ok: true, reserved_usd_micros: reserved + amountMicros, spent_usd_micros: spent }
  })
}

/**
 * Settle exactly once. If a provider reports more than was reserved, record the real amount,
 * mark the dispatch over-budget, and stop future reservations rather than hiding the overrun.
 */
export async function settleSharedBudget(
  dispatchId: string,
  reservationId: string,
  actualMicros: number
): Promise<BudgetResult> {
  if (!Number.isSafeInteger(actualMicros) || actualMicros < 0) {
    return { ok: false, reason: 'invalid_settlement' }
  }
  return tx(async (q) => {
    const dispatch = await q(
      `SELECT id, status, budget_cap_usd_micros, reserved_usd_micros, spent_usd_micros
         FROM staging_agent_dispatches WHERE id = $1 FOR UPDATE`,
      [dispatchId]
    )
    const row = dispatch.rows[0]
    if (!row) return { ok: false, reason: 'dispatch_not_found' }
    const reservations = await q(
      `SELECT amount_usd_micros, settled_usd_micros, status
         FROM staging_agent_budget_reservations
        WHERE dispatch_id = $1 AND reservation_id = $2 FOR UPDATE`,
      [dispatchId, reservationId]
    )
    const reservation = reservations.rows[0]
    if (!reservation) return { ok: false, reason: 'reservation_not_found' }
    if (reservation.status !== 'reserved') {
      return { ok: false, reason: 'reservation_already_settled' }
    }

    const reservedAmount = Number(reservation.amount_usd_micros)
    const reservedTotal = Number(row.reserved_usd_micros)
    const spent = Number(row.spent_usd_micros)
    const cap = Number(row.budget_cap_usd_micros)
    const over = actualMicros > reservedAmount || spent + actualMicros > cap
    await q(
      `UPDATE staging_agent_dispatches
          SET reserved_usd_micros = GREATEST(0, reserved_usd_micros - $2),
              spent_usd_micros = spent_usd_micros + $3,
              status = CASE WHEN $4 THEN 'over_budget' ELSE status END
        WHERE id = $1`,
      [dispatchId, reservedAmount, actualMicros, over]
    )
    await q(
      `UPDATE staging_agent_budget_reservations
          SET status = $3, settled_usd_micros = $4, settled_at = now()
        WHERE dispatch_id = $1 AND reservation_id = $2`,
      [dispatchId, reservationId, over ? 'overrun' : 'settled', actualMicros]
    )
    return over
      ? { ok: false, reason: 'settlement_exceeded_reservation_or_cap', reserved_usd_micros: Math.max(0, reservedTotal - reservedAmount), spent_usd_micros: spent + actualMicros }
      : { ok: true, reserved_usd_micros: Math.max(0, reservedTotal - reservedAmount), spent_usd_micros: spent + actualMicros }
  })
}
