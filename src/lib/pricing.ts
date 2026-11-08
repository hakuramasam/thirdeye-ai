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
  // base is already in USD micros: price_*_1m_usd_micros x tokens / 1e6
  const baseMicros = ((promptTokens * inC) + (completionTokens * outC)) / 1e6
  if (baseMicros <= 0) return 0
  const withMarginMicros = Math.round(baseMicros * (100 + marginPct) / 100)
  const byokRate = byok ? 0.02 : 1 // BYOK calls cover metering costs only (2% of catalog price)
  return Math.max(Math.round(withMarginMicros * byokRate), 1)
}

/**
 * Cost with the cache split. Falls back to the plain input rate wherever a cache rate
 * is not configured, so a model with no cached prices bills exactly as before.
 */
export function computeCostMicrosDetailed(
  m: ModelRow,
  usage: { prompt_tokens: number; completion_tokens: number; input_cached_read: number; input_cache_write: number },
  marginPct: number,
  byok: boolean
): number {
  const pIn = Number(m.price_in_1m_usd_micros)
  const pOut = Number(m.price_out_1m_usd_micros)
  const pCached = (m as any).price_in_cached_1m_usd_micros == null ? pIn : Number((m as any).price_in_cached_1m_usd_micros)
  const pWrite = (m as any).price_in_cache_write_1m_usd_micros == null ? pIn : Number((m as any).price_in_cache_write_1m_usd_micros)

  const cachedRead = Math.min(usage.input_cached_read || 0, usage.prompt_tokens || 0)
  const cacheWrite = Math.min(usage.input_cache_write || 0, Math.max(0, (usage.prompt_tokens || 0) - cachedRead))
  const uncached = Math.max(0, (usage.prompt_tokens || 0) - cachedRead - cacheWrite)

  const baseMicros =
    (uncached * pIn) / 1e6 +
    (cachedRead * pCached) / 1e6 +
    (cacheWrite * pWrite) / 1e6 +
    ((usage.completion_tokens || 0) * pOut) / 1e6
  if (baseMicros <= 0) return 0
  const withMarginMicros = Math.round(baseMicros * (100 + marginPct) / 100)
  const byokRate = byok ? 0.02 : 1
  return Math.max(Math.round(withMarginMicros * byokRate), 1)
}
