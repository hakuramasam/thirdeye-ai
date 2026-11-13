/**
 * Ledger reconciliation.
 *
 * The question this answers is not "what did we charge" but "can the charge be rebuilt from
 * the tokens we stored and the rate card in force". A row whose cost cannot be reproduced is
 * a row we cannot explain to a customer or a provider.
 */
import { query } from '../db/index.js'

export type LedgerRow = {
  model: string
  prompt_tokens: number
  completion_tokens: number
  input_cached_read: number
  input_cache_write: number
  cost_usd_micros: number
  rate_card_version: string | null
  status: string
}

export type RateRow = { model: string; price_in: number; price_out: number }

export function rebuildCostMicros(row: LedgerRow, rates: Map<string, RateRow>, marginPct: number): number {
  const r = rates.get(row.model)
  if (!r) return -1
  const prompt = Number(row.prompt_tokens) || 0
  const cached = Math.min(Number(row.input_cached_read) || 0, prompt)
  const write = Math.min(Number(row.input_cache_write) || 0, prompt - cached)
  const uncached = Math.max(0, prompt - cached - write)
  const out = Number(row.completion_tokens) || 0
  const baseMicros = (uncached * r.price_in + cached * r.price_in + write * r.price_in + out * r.price_out) / 1e6
  if (baseMicros <= 0) return 0
  return Math.max(Math.round(baseMicros * (100 + marginPct) / 100), 1)
}

export function summarize(rows: LedgerRow[], rates: Map<string, RateRow>, marginPct: number) {
  let drifted = 0
  let unrebuildable = 0
  let storedTotal = 0
  let rebuiltTotal = 0
  let missingRateCard = 0
  let cacheOpportunityTokens = 0
  const examples: any[] = []
  for (const row of rows) {
    const stored = Number(row.cost_usd_micros)
    if (stored === 0) continue
    storedTotal += stored
    if (!row.rate_card_version) missingRateCard++
    if (!Number(row.input_cached_read)) cacheOpportunityTokens += Number(row.prompt_tokens) || 0
    const rebuilt = rebuildCostMicros(row, rates, marginPct)
    if (rebuilt < 0) { unrebuildable++; continue }
    rebuiltTotal += rebuilt
    const diff = Math.abs(rebuilt - stored)
    const pct = stored ? (diff / stored) * 100 : 0
    if (pct > 2) {
      drifted++
      if (examples.length < 5) examples.push({ model: row.model, stored, rebuilt, pct: Number(pct.toFixed(1)) })
    }
  }
  return {
    rows_checked: rows.length,
    stored_usd_micros: storedTotal,
    rebuilt_usd_micros: rebuiltTotal,
    drift_total_usd_micros: rebuiltTotal - storedTotal,
    rows_drifted_over_2pct: drifted,
    rows_with_unknown_model: unrebuildable,
    rows_missing_rate_card_version: missingRateCard,
    uncached_prompt_tokens: cacheOpportunityTokens,
    examples,
    within_tolerance: drifted === 0 && unrebuildable === 0,
  }
}

export async function loadRates(): Promise<Map<string, RateRow>> {
  const res = await query('SELECT model, price_in_1m_usd_micros, price_out_1m_usd_micros FROM models_catalog')
  const m = new Map<string, RateRow>()
  for (const r of res.rows) m.set(r.model, { model: r.model, price_in: Number(r.price_in_1m_usd_micros), price_out: Number(r.price_out_1m_usd_micros) })
  return m
}
