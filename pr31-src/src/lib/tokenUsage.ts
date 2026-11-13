/**
 * Token accounting.
 *
 * A prompt can be billed at three different rates depending on where it came from:
 * uncached input, a cache read (usually cheap), or a cache write (usually dearer than
 * plain input). Anthropic reports the split directly; OpenAI reports cached reads and
 * reasoning tokens in detail objects. We normalise both into one shape so the ledger
 * has comparable columns.
 *
 * Where a provider reports nothing, the value stays 0 and the tokens are billed at the
 * plain input rate, which is exactly what we billed before this existed.
 */
export type TokenUsage = {
  prompt_tokens: number
  completion_tokens: number
  input_cached_read: number
  input_cache_write: number
  reasoning_tokens: number
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0
}

export function normalizeUsage(raw: any, fallback?: { prompt?: number; completion?: number }): TokenUsage {
  const u = raw ?? {}
  const prompt_tokens = n(u.prompt_tokens ?? u.input_tokens) || n(fallback?.prompt)
  const completion_tokens = n(u.completion_tokens ?? u.output_tokens) || n(fallback?.completion)

  // Anthropic style: cache_read_input_tokens / cache_creation_input_tokens.
  // OpenAI style: prompt_tokens_details.cached_tokens.
  const cachedRead = n(u.cache_read_input_tokens) || n(u.prompt_tokens_details?.cached_tokens)
  const cacheWrite = n(u.cache_creation_input_tokens)
  const reasoning = n(u.completion_tokens_details?.reasoning_tokens) || n(u.reasoning_tokens)

  // Never let a split exceed the input it is part of, or the ledger double counts.
  const totalCached = Math.min(cachedRead + cacheWrite, prompt_tokens)
  const safeCachedRead = Math.min(cachedRead, totalCached)
  const safeCacheWrite = Math.min(cacheWrite, totalCached - safeCachedRead)

  return {
    prompt_tokens,
    completion_tokens,
    input_cached_read: safeCachedRead,
    input_cache_write: safeCacheWrite,
    reasoning_tokens: Math.min(reasoning, completion_tokens),
  }
}

/** Tokens billed at the full input rate: what is left after the cache split. */
export function uncachedInput(u: TokenUsage): number {
  return Math.max(0, u.prompt_tokens - u.input_cached_read - u.input_cache_write)
}
