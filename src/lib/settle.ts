/**
 * Settling a pending conversion.
 *
 * One implementation shared by the ops route and the executor, so a conversion cannot take a
 * different path depending on who triggered it. The payment row is the lock: only a row still
 * in pending_conversion can be settled, and the update decides the winner under concurrency.
 */
import { one } from '../db/index.js'
import { creditDeposit } from './billing.js'
import { decideCredit } from './creditPolicy.js'
import { CHAINS } from '../payments/chains.js'

export type SettleResult =
  | { ok: true; creditedMicros: number; loadedTo: 'key' | 'account'; apiKeyId: string | null; balanceMicros: number; reason: string }
  | { ok: false; problem: 'not_found' | 'not_pending' | 'no_credit'; detail: string; creditStatus?: string }

export async function settleConversion(
  paymentId: string,
  input: { realisedUsdMicros: number; swapTx: string }
): Promise<SettleResult> {
  const payment = await one('SELECT * FROM payments WHERE id = $1', [paymentId])
  if (!payment) return { ok: false, problem: 'not_found', detail: 'Payment not found' }
  if (payment.status !== 'pending_conversion') {
    return { ok: false, problem: 'not_pending', detail: `Payment is ${payment.status}, not pending_conversion` }
  }

  const chainSlug = (payment as any).chain_slug || 'base'
  const decision = decideCredit({
    chainSlug,
    token: (payment as any).token,
    oracleMicros: Number((payment as any).usd_value_micros ?? 0),
    realisedMicros: input.realisedUsdMicros,
  })
  if (decision.status !== 'credited') {
    return { ok: false, problem: 'no_credit', detail: decision.reason, creditStatus: decision.status }
  }

  const claimed = await one(
    `UPDATE payments SET status = 'recorded', realised_usd_micros = $1, settlement_swap_tx = $2
      WHERE id = $3 AND status = 'pending_conversion' RETURNING id`,
    [input.realisedUsdMicros, input.swapTx, paymentId]
  )
  if (!claimed) return { ok: false, problem: 'not_pending', detail: 'Payment was settled concurrently' }

  let toKeyId: string | null = null
  if ((payment as any).intent_id) {
    const intent = await one('SELECT api_key_id FROM payment_intents WHERE id = $1', [(payment as any).intent_id])
    toKeyId = (intent as any)?.api_key_id ?? null
  }
  const settlement = CHAINS.find((c: any) => c.id === chainSlug)?.settlement
  const dep = await creditDeposit(
    (payment as any).user_id,
    decision.creditMicros,
    { chain: chainSlug, txHash: input.swapTx, token: settlement?.address ?? 'settlement' },
    { toKeyId }
  )
  return {
    ok: true,
    creditedMicros: decision.creditMicros,
    loadedTo: toKeyId ? 'key' : 'account',
    apiKeyId: toKeyId,
    balanceMicros: dep.balance,
    reason: decision.reason,
  }
}
