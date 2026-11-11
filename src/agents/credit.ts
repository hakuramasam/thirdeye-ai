/**
 * Per-agent inference credit.
 *
 * An agent's own pot is spent before the owner's account ledger, so a team can be funded
 * with a fixed allowance per member instead of drawing on one shared balance. The pot is a
 * real ceiling, not a display: when it runs out the agent falls back to the ledger, and if
 * neither can pay the step is refused rather than half-charged.
 */

import { query } from '../db/index.js'
import { debitForUsage } from '../lib/billing.js'
import { isCovered } from '../lib/allowance.js'

/** Split a charge between the agent's pot and the owner's ledger. Pure. */
export function splitDebit(potMicros: number, costMicros: number): { fromPot: number; fromLedger: number } {
  const cost = Math.max(0, Math.trunc(costMicros))
  const pot = Math.max(0, Math.trunc(potMicros))
  const fromPot = Math.min(cost, pot)
  return { fromPot, fromLedger: cost - fromPot }
}

/** Remaining credit on one agent, in micro-dollars. */
export async function getAgentCredit(agentId: string): Promise<number> {
  const r = await query(`SELECT credit_usd_micros FROM agents WHERE id = $1`, [agentId])
  if (!r.rows.length) return 0
  return Number(r.rows[0].credit_usd_micros ?? 0)
}

/**
 * Take up to `amountMicros` from the pot. The conditional update means two concurrent
 * steps can never spend the same micros; it returns what was actually taken.
 */
export async function takeAgentCredit(agentId: string, amountMicros: number): Promise<number> {
  const want = Math.max(0, Math.trunc(amountMicros))
  if (want === 0) return 0
  const r = await query(
    `UPDATE agents SET credit_usd_micros = credit_usd_micros - $1
      WHERE id = $2 AND credit_usd_micros >= $1
      RETURNING credit_usd_micros`,
    [want, agentId]
  )
  return r.rows.length ? want : 0
}

/** Put credit back, so a failed settlement never leaves a half-charge. */
export async function refundAgentCredit(agentId: string, amountMicros: number): Promise<void> {
  const amount = Math.max(0, Math.trunc(amountMicros))
  if (amount === 0) return
  await query(`UPDATE agents SET credit_usd_micros = credit_usd_micros + $1 WHERE id = $2`, [amount, agentId])
}

/** Add or set an agent's pot. `mode: 'set'` replaces the balance, `'add'` tops it up. */
export async function fundAgentCredit(
  agentId: string,
  amountMicros: number,
  mode: 'add' | 'set' = 'add'
): Promise<number | null> {
  const amount = Math.trunc(amountMicros)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('amount must be a non-negative integer')
  const r =
    mode === 'set'
      ? await query(`UPDATE agents SET credit_usd_micros = $1 WHERE id = $2 RETURNING credit_usd_micros`, [amount, agentId])
      : await query(`UPDATE agents SET credit_usd_micros = credit_usd_micros + $1 WHERE id = $2 RETURNING credit_usd_micros`, [amount, agentId])
  if (!r.rows.length) return null
  return Number(r.rows[0].credit_usd_micros)
}

export type StepPayment = {
  ok: boolean
  fromPot: number
  fromLedger: number
  reason?: 'insufficient_credits'
}

/**
 * Pay for one model step: pot first, ledger second, all-or-nothing.
 * If the ledger cannot cover the remainder the pot's share is refunded, because a step
 * that could not be billed in full must not leave a partial charge behind.
 */
export async function payForStep(opts: {
  agentId: string
  userId: string
  wallet: string
  runId: string
  costMicros: number
}): Promise<StepPayment> {
  const pot = await getAgentCredit(opts.agentId)
  const { fromPot, fromLedger } = splitDebit(pot, opts.costMicros)

  let taken = 0
  if (fromPot > 0) taken = await takeAgentCredit(opts.agentId, fromPot)

  if (fromLedger > 0) {
    const debit = await debitForUsage(opts.userId, fromLedger, `agent:${opts.runId}`, {
      allowNegative: await isCovered(opts.wallet),
    })
    if (!debit.ok) {
      if (taken > 0) await refundAgentCredit(opts.agentId, taken)
      return { ok: false, fromPot: 0, fromLedger: 0, reason: 'insufficient_credits' }
    }
  }
  return { ok: true, fromPot: taken, fromLedger }
}
