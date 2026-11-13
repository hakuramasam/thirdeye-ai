import { one, query } from '../db/index.js'
import { newId } from './env.js'

/**
 * Credit allowances for founder/partner wallets.
 *
 * An allowance does not mint credit: the wallet's balance still goes negative as it
 * consumes inference, so every free call stays visible in the ledger as a real cost.
 * The allowance only removes the insufficient-credit refusal for that wallet.
 */
export type Allowance = {
  id: string
  wallet: string
  label: string
  monthlyCapUsdMicros: number
  enabled: boolean
}

/** Pure: is this month's usage still inside the allowance? cap 0 = uncapped. */
export function allowanceAllows(monthlyCapUsdMicros: number, usedThisMonthMicros: number): boolean {
  if (monthlyCapUsdMicros <= 0) return true
  return usedThisMonthMicros < monthlyCapUsdMicros
}

export async function getAllowance(wallet: string): Promise<Allowance | null> {
  if (!wallet) return null
  const r = await one(
    `SELECT id, wallet, label, monthly_cap_usd_micros, enabled
       FROM credit_allowances WHERE lower(wallet) = lower($1) AND enabled = true`,
    [wallet]
  )
  if (!r) return null
  return {
    id: r.id,
    wallet: r.wallet,
    label: r.label,
    monthlyCapUsdMicros: Number(r.monthly_cap_usd_micros),
    enabled: r.enabled,
  }
}

/** Usage spend recorded for a wallet's accounts since the start of the month. */
export async function usedThisMonthMicros(wallet: string): Promise<number> {
  const r = await one(
    `SELECT COALESCE(SUM(-l.amount_usd_micros), 0)::bigint AS spent
       FROM ledger l JOIN users u ON u.id = l.user_id
      WHERE lower(u.wallet) = lower($1)
        AND l.kind = 'usage'
        AND l.created_at >= date_trunc('month', now())`,
    [wallet]
  )
  return Number(r?.spent ?? 0)
}

/** True when this wallet may keep calling despite a low balance. */
export async function isCovered(wallet: string): Promise<boolean> {
  const a = await getAllowance(wallet)
  if (!a) return false
  const used = await usedThisMonthMicros(wallet)
  return allowanceAllows(a.monthlyCapUsdMicros, used)
}

export async function listAllowances(): Promise<Allowance[]> {
  const r = await query('SELECT id, wallet, label, monthly_cap_usd_micros, enabled FROM credit_allowances ORDER BY created_at DESC', [])
  return r.rows.map((x) => ({
    id: x.id,
    wallet: x.wallet,
    label: x.label,
    monthlyCapUsdMicros: Number(x.monthly_cap_usd_micros),
    enabled: x.enabled,
  }))
}

export async function grantAllowance(input: {
  wallet: string
  label: string
  monthlyCapUsdMicros?: number
  note?: string
}): Promise<Allowance> {
  const id = `alw_${newId()}`
  const cap = input.monthlyCapUsdMicros ?? 0
  await query(
    `INSERT INTO credit_allowances (id, wallet, label, monthly_cap_usd_micros, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (lower(wallet)) DO UPDATE
       SET label = EXCLUDED.label,
           monthly_cap_usd_micros = EXCLUDED.monthly_cap_usd_micros,
           note = EXCLUDED.note,
           enabled = true`,
    [id, input.wallet, input.label, cap, input.note ?? null]
  )
  const a = await getAllowance(input.wallet)
  if (!a) throw new Error('allowance insert failed')
  return a
}
