import { query } from '../db/index.js'
import { monthStart } from './keys.js'
import type { ApiKeyRow } from './types.js'

export type KeyBudgetState = {
  /** Monthly cap in USD micros, or null when the key is uncapped. */
  cap: number | null
  /** Spent so far in the current monthly period, in USD micros. */
  spent: number
  /** Remaining allowance in USD micros (Infinity when uncapped). */
  remaining: number
  /** True when the cap is exhausted and calls must be refused. */
  exhausted: boolean
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Roll the key's budget period forward when a new UTC month has begun.
 * Returns the key row with an up-to-date period_start / period_spent.
 */
async function rollPeriodIfNeeded(apiKey: ApiKeyRow): Promise<{ cap: number | null; spent: number; start: string | null }> {
  const cap = apiKey.budget_usd_micros == null ? null : num(apiKey.budget_usd_micros)
  if (cap == null) return { cap: null, spent: 0, start: null }

  const currentPeriod = monthStart()
  const storedStart = apiKey.period_start ? new Date(apiKey.period_start).toISOString() : null

  if (storedStart !== currentPeriod) {
    await query(
      `UPDATE api_keys SET period_start = $1, period_spent_usd_micros = 0 WHERE id = $2`,
      [currentPeriod, apiKey.id]
    )
    return { cap, spent: 0, start: currentPeriod }
  }
  return { cap, spent: num(apiKey.period_spent_usd_micros), start: storedStart }
}

/** Inspect a key's monthly budget before serving a call. */
export async function checkKeyBudget(apiKey: ApiKeyRow): Promise<KeyBudgetState> {
  const { cap, spent } = await rollPeriodIfNeeded(apiKey)
  if (cap == null) return { cap: null, spent: 0, remaining: Infinity, exhausted: false }
  const remaining = cap - spent
  return { cap, spent, remaining, exhausted: remaining <= 0 }
}

/** Add a call's cost to the key's current monthly period spend. */
export async function chargeKeyBudget(apiKey: ApiKeyRow, costMicros: number): Promise<void> {
  if (!apiKey.budget_usd_micros || costMicros <= 0) return
  await query(
    `UPDATE api_keys SET period_spent_usd_micros = period_spent_usd_micros + $1 WHERE id = $2`,
    [costMicros, apiKey.id]
  )
}
