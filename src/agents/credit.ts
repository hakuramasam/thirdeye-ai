/**
 * Per-agent inference credit.
 *
 * An agent's own pot is spent before the owner's account ledger, so a team can be funded
 * with a fixed allowance per member instead of drawing on one shared balance. The pot is a
 * real ceiling, not a display: when it runs out the agent falls back to the ledger, and if
 * neither can pay the step is refused rather than half-charged.
 */

import { query, tx } from '../db/index.js'
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
export async function takeAgentCredit(agentId: string, amountMicros: number, ref?: string): Promise<number> {
  const want = Math.max(0, Math.trunc(amountMicros))
  if (want === 0) return 0
  return tx(async (q) => {
    const r = await q(
      `UPDATE agents SET credit_usd_micros = credit_usd_micros - $1
        WHERE id = $2 AND credit_usd_micros >= $1
        RETURNING user_id, credit_usd_micros`,
      [want, agentId]
    )
    if (!r.rows.length) return 0
    await q(
      `INSERT INTO agent_credit_ledger (agent_id, amount_usd_micros, kind, ref, actor, balance_after)
       VALUES ($1, $2, 'usage', $3, 'agent-runner', $4)`,
      [agentId, -want, ref ?? null, Number(r.rows[0].credit_usd_micros)]
    )
    return want
  })
}

/** Put credit back, so a failed settlement never leaves a half-charge. */
export async function refundAgentCredit(agentId: string, amountMicros: number, ref?: string): Promise<void> {
  const amount = Math.max(0, Math.trunc(amountMicros))
  if (amount === 0) return
  await tx(async (q) => {
    const r = await q(
      `UPDATE agents SET credit_usd_micros = credit_usd_micros + $1
        WHERE id = $2 RETURNING credit_usd_micros`,
      [amount, agentId]
    )
    if (!r.rows.length) return
    await q(
      `INSERT INTO agent_credit_ledger (agent_id, amount_usd_micros, kind, ref, actor, balance_after)
       VALUES ($1, $2, 'refund', $3, 'agent-runner', $4)`,
      [agentId, amount, ref ?? null, Number(r.rows[0].credit_usd_micros)]
    )
  })
}

/** Add or set an agent's pot. Set replaces the balance; add tops it up. */
export async function fundAgentCredit(
  agentId: string,
  amountMicros: number,
  mode: 'add' | 'set' = 'add',
  audit: { ref?: string; actor?: string } = {}
): Promise<number | null> {
  const amount = Math.trunc(amountMicros)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('amount must be a non-negative integer')
  return tx(async (q) => {
    const current = await q('SELECT credit_usd_micros FROM agents WHERE id = $1 FOR UPDATE', [agentId])
    if (!current.rows.length) return null
    const before = Number(current.rows[0].credit_usd_micros ?? 0)
    const after = mode === 'set' ? amount : before + amount
    const delta = after - before
    await q('UPDATE agents SET credit_usd_micros = $1 WHERE id = $2', [after, agentId])
    if (delta !== 0) {
      await q(
        `INSERT INTO agent_credit_ledger (agent_id, amount_usd_micros, kind, ref, actor, balance_after)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [agentId, delta, delta > 0 ? 'fund' : 'adjust', audit.ref ?? null, audit.actor ?? 'admin-api', after]
      )
    }
    return after
  })
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
  if (fromPot > 0) taken = await takeAgentCredit(opts.agentId, fromPot, opts.runId)

  if (fromLedger > 0) {
    const debit = await debitForUsage(opts.userId, fromLedger, `agent:${opts.runId}`, {
      allowNegative: await isCovered(opts.wallet),
    })
    if (!debit.ok) {
      if (taken > 0) await refundAgentCredit(opts.agentId, taken, opts.runId)
      return { ok: false, fromPot: 0, fromLedger: 0, reason: 'insufficient_credits' }
    }
  }
  return { ok: true, fromPot: taken, fromLedger }
}
