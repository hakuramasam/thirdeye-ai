/**
 * Web search as an agent tool.
 *
 * Deliberately NOT registered in the runner by default. A tool that reaches the public internet
 * on behalf of an agent is an egress path, and an agent holding one plus a credential is how data
 * leaves a system. It stays behind WEB_SEARCH_ENABLED until the role-scoped authority gates land,
 * so enabling it is a decision rather than a side effect of merging.
 *
 * Provider-agnostic on purpose: Brave and Tavily are both supported because the right choice is a
 * cost and coverage decision, not an architectural one. Both are normalised to one result shape so
 * the tool contract does not change when the provider does.
 */

export type WebSearchResult = { title: string; url: string; snippet: string }

export type WebSearchDeps = {
  /** Injected for tests. Never a live socket in a unit test. */
  fetchImpl?: typeof fetch
  apiKey?: string
  /** Widen to string: an unrecognised value must be refused, not cast. */
  provider?: string
  timeoutMs?: number
  /** Injected for tests; defaults to WEB_SEARCH_ENABLED. */
  enabled?: boolean
}

export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the public web and return ranked results with title, url and snippet. Use it when the answer depends on something newer than your training data or that you cannot verify from the repository.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for. Be specific; this is a search query, not a question.' },
      count: { type: 'integer', description: 'How many results to return, 1 to 10. Defaults to 5.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const

/**
 * The runner builds every tool entry as `{ type: 'function', function: {...} }`. Exporting the
 * wrapped form means registering this tool cannot produce an entry the provider rejects.
 */
export const WEB_SEARCH_FUNCTION_TOOL = { type: 'function' as const, function: WEB_SEARCH_TOOL }

const ALLOWED_ARGS = new Set(['query', 'count'])

/** Ceiling on one provider request, so a hung search cannot consume the invocation. */
const DEFAULT_TIMEOUT_MS = 10_000

/** Off unless the deployment says otherwise, and off is the safe default for an egress tool. */
export function isWebSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.WEB_SEARCH_ENABLED || '').toLowerCase() === 'true'
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebSearchError'
  }
}

function clampCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 5
  return Math.min(10, Math.max(1, Math.floor(n)))
}

/**
 * Normalise both providers into one shape. Brave nests under web.results with `description`,
 * Tavily returns a flat `results` with `content`. Doing this here means callers and the model never
 * see a provider-shaped payload.
 */
function normalise(provider: 'brave' | 'tavily', body: any): WebSearchResult[] {
  const raw = provider === 'brave' ? body?.web?.results ?? [] : body?.results ?? []
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 10).map((r: any) => ({
    title: String(r?.title ?? r?.name ?? '').slice(0, 300),
    url: String(r?.url ?? r?.link ?? '').slice(0, 2000),
    snippet: String(r?.description ?? r?.content ?? r?.snippet ?? '').slice(0, 1000),
  }))
}

export async function runWebSearch(
  args: Record<string, unknown>,
  deps: WebSearchDeps = {},
): Promise<{ query: string; provider: string; results: WebSearchResult[] }> {
  for (const key of Object.keys(args || {})) {
    if (!ALLOWED_ARGS.has(key)) throw new WebSearchError(`web_search does not accept the argument "${key}"`)
  }
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) throw new WebSearchError('web_search requires a non-empty query')
  if (query.length > 400) throw new WebSearchError('web_search query is longer than 400 characters')

  // The flag gates the whole handler: a disabled tool must not read a key or open a socket, even when
  // a caller reaches the exported function directly instead of through the runner.
  const enabled = deps.enabled ?? isWebSearchEnabled()
  if (!enabled) {
    throw new WebSearchError('web_search is disabled; set WEB_SEARCH_ENABLED=true to allow network calls')
  }

  // Validate before the key is read. A cast let a typo such as "Tavily" or "brave " through, which
  // then sent WEB_SEARCH_API_KEY to Brave while normalisation read the Tavily shape, so a real
  // response came back as zero results and looked like a working search.
  const rawProvider = String(deps.provider ?? process.env.WEB_SEARCH_PROVIDER ?? 'brave').trim().toLowerCase()
  if (rawProvider !== 'brave' && rawProvider !== 'tavily') {
    throw new WebSearchError(`WEB_SEARCH_PROVIDER must be "brave" or "tavily", not "${rawProvider}"`)
  }
  const provider = rawProvider as 'brave' | 'tavily'

  const apiKey = deps.apiKey ?? process.env.WEB_SEARCH_API_KEY ?? ''
  if (!apiKey) throw new WebSearchError('WEB_SEARCH_API_KEY is not set, so web_search cannot run')
  const count = clampCount(args?.count)
  const doFetch = deps.fetchImpl ?? fetch
  // A finite default: without one a stalled provider holds the whole invocation open.
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))

  let res: Response
  if (provider === 'tavily') {
    res = await doFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }),
      signal,
    })
  } else {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
    res = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal,
    })
  }

  if (!res.ok) {
    // The body can echo request context; keep the message short and never re-emit headers.
    throw new WebSearchError(`web_search provider ${provider} returned HTTP ${res.status}`)
  }
  const body = await res.json().catch(() => ({}))
  return { query, provider, results: normalise(provider, body) }
}
