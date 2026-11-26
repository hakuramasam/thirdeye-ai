import { UpstreamError, mapTimeoutError, requestSignal } from './index.js'

function buildEndpoint(baseUrl?: string | null): string {
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  if (base.endsWith('/chat/completions')) {
    return base
  }
  return `${base}/chat/completions`
}

export async function callOpenAIChat({
  baseUrl,
  apiKey,
  params,
  timeoutMs,
}: {
  baseUrl?: string | null
  apiKey: string
  params: Record<string, any>
  /** Abort the request after this long. A scheduled run must answer before the platform kills it. */
  timeoutMs?: number
}): Promise<{
  content: string
  prompt_tokens: number
  completion_tokens: number
  tool_calls?: any[]
  raw?: any
}> {
  const endpoint = buildEndpoint(baseUrl)
  // One timer per request: computing this twice discarded the first AbortSignal.
  const signal = requestSignal(timeoutMs)
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...params, stream: false }),
      ...(signal ? { signal } : {}),
    })
  } catch (e: any) {
    // An aborted call is our own deadline, not an upstream verdict: name it so the run records
    // "timed out" rather than an empty network error nobody can diagnose.
    mapTimeoutError(e, timeoutMs)
  }

  if (!res.ok) {
    // A refusal body is not a verdict, but an abort while reading it is our own deadline and must
    // not be swallowed as "no reason given": the caller has to see why nothing came back.
    let errBody: any = null
    try {
      errBody = await res.json()
    } catch (e: any) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') mapTimeoutError(e, timeoutMs)
    }
    const msg = errBody?.error?.message || `Upstream OpenAI error: ${res.statusText || res.status}`
    throw new UpstreamError(msg, res.status, errBody || { error: { message: msg, type: 'upstream', code: res.status } })
  }

  // The body read can abort after the headers arrived, so it needs the same mapping as the fetch:
  // otherwise a deadline lands as `uncaught_exception` instead of `deadline_exceeded`.
  let data: any
  try {
    data = await res.json()
  } catch (e: any) {
    mapTimeoutError(e, timeoutMs)
  }
  const choice = data.choices?.[0]
  const message = choice?.message ?? {}
  const content = message.content ?? ''
  const tool_calls = message.tool_calls

  let prompt_tokens = data.usage?.prompt_tokens
  let completion_tokens = data.usage?.completion_tokens

  if (typeof prompt_tokens !== 'number') {
    prompt_tokens = Math.ceil(JSON.stringify(params.messages || []).length / 4)
  }
  if (typeof completion_tokens !== 'number') {
    completion_tokens = Math.ceil((content || '').length / 4)
  }

  return {
    content,
    prompt_tokens,
    completion_tokens,
    tool_calls,
    raw: data,
  }
}

export async function callOpenAIStream({
  baseUrl,
  apiKey,
  params,
}: {
  baseUrl?: string | null
  apiKey: string
  params: Record<string, any>
}): Promise<Response> {
  const endpoint = buildEndpoint(baseUrl)
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...params, stream: true }),
  })

  if (!res.ok) {
    const errBody = await res.json().catch(() => null)
    const msg = errBody?.error?.message || `Upstream OpenAI stream error: ${res.statusText || res.status}`
    throw new UpstreamError(msg, res.status, errBody || { error: { message: msg, type: 'upstream', code: res.status } })
  }

  return res
}
