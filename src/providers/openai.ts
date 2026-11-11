import { UpstreamError } from './index.js'

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
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...params, stream: false }),
      ...(timeoutMs && timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
  } catch (e: any) {
    // An aborted call is our own deadline, not an upstream verdict: name it so the run records
    // "timed out" rather than an empty network error nobody can diagnose.
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new UpstreamError(`provider call timed out after ${timeoutMs}ms`, 504, {
        error: { message: `provider call timed out after ${timeoutMs}ms`, type: 'timeout', code: 504 },
      })
    }
    throw e
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => null)
    const msg = errBody?.error?.message || `Upstream OpenAI error: ${res.statusText || res.status}`
    throw new UpstreamError(msg, res.status, errBody || { error: { message: msg, type: 'upstream', code: res.status } })
  }

  const data: any = await res.json()
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
