/**
 * Normalise the model catalogue into one shape the UI can rely on.
 *
 * The dashboard has read the same catalogue two different ways: `/api/models` answers
 * `{ models: [{ model, provider, price_in_1m_usd_micros, price_out_1m_usd_micros }] }`
 * while the OpenAI-compatible surface answers `{ data: [{ id, owned_by, pricing }] }`.
 * The Playground assumed the second shape, read `m.id` off the first, and got undefined
 * for every row: the dropdown rendered ten *blank* options, the selected value matched
 * nothing, and picking one sent no model at all ("Missing model or messages in request body").
 *
 * Anything without a usable identifier is dropped rather than shown as a nameless choice,
 * because an option a user cannot read is worse than one that is missing.
 */
export type CatalogModel = {
  /** What the API call must send. */
  id: string
  /** Provider, when the catalogue names one. */
  provider: string | null
  /** Input price per million tokens in USD, or null when the catalogue does not price it. */
  promptUsdPerMillion: number | null
  /** Output price per million tokens in USD, or null. */
  completionUsdPerMillion: number | null
}

function asMicros(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * `/api/v1/models` publishes `pricing.prompt` and `pricing.completion` already in USD per 1M
 * tokens (gpt-4o-mini reports "0.15"), which is the unit the catalogue displays. Treating them as
 * per-token and multiplying by a million inflated every price by 1,000,000x, so this parses them
 * as-is and only rounds away float artefacts.
 */
function usdPerMillion(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) / 1e6 : null
}

export function normalizeModels(raw: unknown): CatalogModel[] {
  const body: any = raw ?? {}
  const rows: any[] = Array.isArray(body)
    ? body
    : Array.isArray(body.models)
      ? body.models
      : Array.isArray(body.data)
        ? body.data
        : []

  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const id = String(r?.id ?? r?.model ?? r?.name ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const promptMicros = asMicros(r?.price_in_1m_usd_micros)
    const completionMicros = asMicros(r?.price_out_1m_usd_micros)
    out.push({
      id,
      provider: typeof r?.provider === 'string' ? r.provider : typeof r?.owned_by === 'string' ? r.owned_by : null,
      promptUsdPerMillion: promptMicros !== null ? promptMicros / 1_000_000 : usdPerMillion(r?.pricing?.prompt),
      completionUsdPerMillion:
        completionMicros !== null ? completionMicros / 1_000_000 : usdPerMillion(r?.pricing?.completion),
    })
  }
  return out
}

/** A sub-cent price formatted to two decimals would read as free, so show four below one cent. */
function fmtPerMillion(n: number): string {
  if (n === 0) return '0.00'
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2)
}

/** One line of option text: always names the model, and adds its input price when known. */
export function modelLabel(m: CatalogModel): string {
  return m.promptUsdPerMillion === null
    ? m.id
    : `${m.id} · $${fmtPerMillion(m.promptUsdPerMillion)}/M in`
}
