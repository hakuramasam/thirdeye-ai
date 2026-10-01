/** Model catalog + pricing helpers. Money is USD micros (1_000_000 = $1). */

export type ModelRow = {
  model: string
  provider: string
  upstream_model: string
  base_url: string | null
  price_in_1m_usd_micros: string | number
  price_out_1m_usd_micros: string | number
  enabled: boolean
}

/** Billed cost in micros: tokens * price, plus platform margin on brokered calls. */
export function computeCostMicros(
  m: ModelRow,
  promptTokens: number,
  completionTokens: number,
  marginPct: number,
  byok: boolean
): number {
  const inC = Number(m.price_in_1m_usd_micros)
  const outC = Number(m.price_out_1m_usd_micros)
  const base = (promptTokens * inC) / 1e6 + (completionTokens * outC) / 1e6
  const withMargin = base * (1 + marginPct / 100)
  const byokRate = byok ? 0.02 : 1 // BYOK calls cover metering costs only (2% of catalog price)
  return Math.ceil(base <= 0 ? 0 : Math.max(withMargin * byokRate, 1))
}
