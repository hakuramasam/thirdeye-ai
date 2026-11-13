/**
 * Paragraph API client.
 *
 * Path C of https://docs.paragraph.com/developers/agent-setup (REST, for code that calls
 * Paragraph directly). Base URL https://public.api.paragraph.com/api, authenticated with
 * `Authorization: Bearer <key>`.
 *
 * Rules taken from that page and enforced here:
 *  - the key is read from PARAGRAPH_API_KEY only; it is never logged, echoed or returned
 *  - anything that publishes, emails or deletes is left to the caller's explicit approval,
 *    so this client exposes drafts but no publish helper
 *  - a missing key is a clean refusal, not a crash
 */

const DEFAULT_BASE = 'https://public.api.paragraph.com/api'

export type ParagraphResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string }

function baseUrl(): string {
  return (process.env.PARAGRAPH_API_BASE || DEFAULT_BASE).replace(/\/+$/, '')
}

/** The key itself, or empty. Callers should use paragraphConfigured() rather than reading this. */
function apiKey(): string {
  return (process.env.PARAGRAPH_API_KEY || '').trim()
}

export function paragraphConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.PARAGRAPH_API_KEY || '').trim())
}

/**
 * Remove the key from anything that might travel onward into a log or an HTTP response.
 * Provider errors sometimes echo the request back, so redaction happens on every message.
 */
export function redactKey(text: string, key = apiKey()): string {
  let out = String(text ?? '')
  // Bearer values first: they swallow any suffix that follows the key, so the raw key never
  // survives as a remainder like "[redacted]xyz".
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[redacted]')
  if (key && key.length >= 8) out = out.split(key).join('[redacted]')
  return out.slice(0, 400)
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  timeoutMs?: number
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** One authenticated call. Never throws: every failure comes back as { ok: false }. */
export async function paragraphRequest<T>(path: string, opts: RequestOptions = {}): Promise<ParagraphResult<T>> {
  const key = apiKey()
  if (!key) {
    return {
      ok: false,
      status: 0,
      code: 'not_configured',
      message: 'PARAGRAPH_API_KEY is not set; add it in Settings -> API keys and set the variable',
    }
  }
  const url = new URL(`${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`)
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    })
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      code: 'network_error',
      message: redactKey(`Paragraph request failed: ${e?.message ?? e}`, key),
    }
  }

  const text = await res.text().catch(() => '')
  let parsed: any = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  if (!res.ok) {
    const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? text ?? `HTTP ${res.status}`
    const code =
      res.status === 401 || res.status === 403
        ? 'unauthorized'
        : res.status === 404
          ? 'not_found'
          : res.status === 429
            ? 'rate_limited'
            : `http_${res.status}`
    return { ok: false, status: res.status, code, message: redactKey(String(detail), key) }
  }

  // Several Paragraph endpoints answer { data: ... }; unwrap that when it is the only wrapper.
  const data = parsed && typeof parsed === 'object' && 'data' in parsed && Object.keys(parsed).length === 1 ? parsed.data : parsed
  return { ok: true, data: data as T }
}

// ── Read-only surface ───────────────────────────────────────────────────────────

export type ParagraphPublication = {
  id: string
  name?: string
  slug?: string
  [k: string]: unknown
}

/** The publication the key belongs to. This is the setup doc's connectivity check. */
export function getMe(opts: RequestOptions = {}) {
  return paragraphRequest<ParagraphPublication>('/v1/me', opts)
}

export function getPublicationBySlug(slug: string, opts: RequestOptions = {}) {
  return paragraphRequest<ParagraphPublication>(`/v1/publications/slug/${encodeURIComponent(slug)}`, opts)
}

export function getSubscriberCount(publicationId: string, opts: RequestOptions = {}) {
  return paragraphRequest<{ count?: number }>(
    `/v1/publications/${encodeURIComponent(publicationId)}/subscribers/count`,
    opts
  )
}

export function listPublicationPosts(
  publicationId: string,
  params: { limit?: number; offset?: number } = {},
  opts: RequestOptions = {}
) {
  return paragraphRequest<unknown[]>(`/v1/publications/${encodeURIComponent(publicationId)}/posts`, {
    ...opts,
    query: { limit: params.limit, offset: params.offset, ...(opts.query ?? {}) },
  })
}

export function getPost(postId: string, opts: RequestOptions = {}) {
  return paragraphRequest<Record<string, unknown>>(`/v1/posts/${encodeURIComponent(postId)}`, opts)
}

export function listPostsFeed(params: { limit?: number } = {}, opts: RequestOptions = {}) {
  return paragraphRequest<unknown[]>('/v1/posts/feed', { ...opts, query: { limit: params.limit, ...(opts.query ?? {}) } })
}

export function listAgents(opts: RequestOptions = {}) {
  return paragraphRequest<unknown[]>('/v1/agents', opts)
}

export function getAgent(agentKey: string, opts: RequestOptions = {}) {
  return paragraphRequest<Record<string, unknown>>(`/v1/agents/${encodeURIComponent(agentKey)}`, opts)
}

export function listAgentRuns(agentKey: string, params: { limit?: number } = {}, opts: RequestOptions = {}) {
  return paragraphRequest<unknown[]>(`/v1/agents/${encodeURIComponent(agentKey)}/runs`, {
    ...opts,
    query: { limit: params.limit, ...(opts.query ?? {}) },
  })
}

// ── Draft-only writes ──────────────────────────────────────────────────────────

export type DraftInput = {
  /** Paragraph accepts a title and a body; keep this loose so a schema change cannot break us. */
  title: string
  body?: string
  subtitle?: string
  [k: string]: unknown
}

/**
 * Create a draft. Drafts never go public on their own, which is why this is allowed without a
 * second approval; publishing uses the post endpoints and belongs behind the owner's word.
 */
export function createDraft(input: DraftInput, opts: RequestOptions = {}) {
  return paragraphRequest<Record<string, unknown>>('/v1/content', { ...opts, method: 'POST', body: input })
}

export function getContent(contentId: string, opts: RequestOptions = {}) {
  return paragraphRequest<Record<string, unknown>>(`/v1/content/${encodeURIComponent(contentId)}`, opts)
}
