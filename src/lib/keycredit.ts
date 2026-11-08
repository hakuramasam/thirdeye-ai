import { one } from '../db/index.js'
import { debitForUsage } from './billing.js'

/**
 * Key-scoped credit.
 *
 * A payment tagged to a key funds that key, not the account. Calls spend the key credit
 * first and fall back to the account ledger, so a key can be handed to a client holding
 * its own money and nothing else reachable.
 *
 * Invariant: money is never created here. Key credit only increases from a verified
 * deposit and only decreases from a real call.
 */

export function splitKeyCredit(keyCreditMicros: number, costMicros: number): { fromKey: number; fromAccount: number } {
  const credit = Math.max(0, Math.floor(Number(keyCreditMicros) || 0))
  const cost = Math.max(0, Math.floor(Number(costMicros) || 0))
  const fromKey = Math.min(credit, cost)
  return { fromKey, fromAccount: cost - fromKey }
}

export async function getKeyCreditMicros(keyId: string): Promise<number> {
  const r = await one('SELECT credit_usd_micros FROM api_keys WHERE id = $1', [keyId])
  return Number(r?.credit_usd_micros ?? 0)
}

/** Add verified funds to a key. Returns the new key credit. */
export async function creditKey(keyId: string, amountMicros: number): Promise<number> {
  const amt = Math.max(0, Math.floor(Number(amountMicros) || 0))
  if (amt <= 0) return getKeyCreditMicros(keyId)
  const r = await one(
    'UPDATE api_keys SET credit_usd_micros = credit_usd_micros + $1 WHERE id = $2 RETURNING credit_usd_micros',
    [amt, keyId]
  )
  return Number(r?.credit_usd_micros ?? 0)
}

/**
 * Take up to amountMicros from the key. The conditional update means two concurrent
 * calls cannot both spend the same credit.
 */
export async function debitKey(keyId: string, amountMicros: number): Promise<number> {
  const want = Math.max(0, Math.floor(Number(amountMicros) || 0))
  if (want <= 0) return 0
  const r = await one(
    `UPDATE api_keys SET credit_usd_micros = credit_usd_micros - $1
      WHERE id = $2 AND credit_usd_micros >= $1
      RETURNING credit_usd_micros`,
    [want, keyId]
  )
  return r ? want : 0
}

export type ChargeResult = { ok: boolean; spentFromKey: number; spentFromAccount: number; keyCredit: number; accountBalance: number }

/** Charge a call: key credit first, then the account ledger. */
export async function chargeCall(
  keyId: string,
  userId: string,
  costMicros: number,
  ref: string,
  opts: { allowNegative?: boolean } = {}
): Promise<ChargeResult> {
  const available = await getKeyCreditMicros(keyId)
  const { fromKey, fromAccount } = splitKeyCredit(available, costMicros)
  const spentFromKey = await debitKey(keyId, fromKey)
  const accountCharge = costMicros - spentFromKey
  const debit = await debitForUsage(userId, accountCharge, ref, opts)
  if (!debit.ok) {
    // The account could not cover the rest, so return the key's share: no half-charges.
    await creditKey(keyId, spentFromKey)
    return { ok: false, spentFromKey: 0, spentFromAccount: 0, keyCredit: await getKeyCreditMicros(keyId), accountBalance: debit.balance }
  }
  return {
    ok: true,
    spentFromKey,
    spentFromAccount: accountCharge,
    keyCredit: await getKeyCreditMicros(keyId),
    accountBalance: debit.balance,
  }
}
