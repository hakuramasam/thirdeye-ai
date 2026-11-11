/**
 * Bounded retry for provider rate limits.
 *
 * A free-tier model provider meters tokens per minute, and a scheduled run has nobody to
 * press "try again": the tick is spent, the slot is used and the team reports an error it
 * could have avoided by waiting the few seconds the provider itself asked for. The budget
 * stays inside the serverless function's lifetime, so a long queue is still a failure.
 */

/** Milliseconds the provider asked us to wait, or null when it did not say. */
export function retryDelayMs(message: string): number | null {
  const m = /try again in ([\d.]+)\s*s/i.exec(message) || /retry[- ]after:?\s*([\d.]+)/i.exec(message)
  if (!m) return null
  const seconds = Number(m[1])
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(60_000, Math.ceil(seconds * 1000) + 250)
}

/** True when the failure is the provider's meter rather than our request. */
export function isRateLimitError(message: string): boolean {
  return /rate limit|429|too many requests|tokens per minute/i.test(message)
}

export type RetryOptions = {
  attempts?: number
  /** Ceiling on time spent waiting across all attempts, so the run still returns. */
  totalWaitMs?: number
  /**
   * Absolute epoch ms a wait may not end after: the caller's remaining function lifetime.
   * A budget alone is not enough when a run makes several calls, because each call would spend
   * the whole budget again and the last one would return after the platform had already killed it.
   * The caller owns the headroom: it is the caller that knows the ceiling.
   */
  deadlineMs?: number
  sleep?: (ms: number) => Promise<void>
}


/** Call `fn`, waiting out a rate limit the provider told us about, up to a fixed budget. */
export async function callWithRateLimitRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3
  const totalWaitMs = opts.totalWaitMs ?? 25_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let waited = 0

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e: any) {
      const message = String(e?.message ?? e)
      if (!isRateLimitError(message) || attempt >= attempts) throw e
      const wait = retryDelayMs(message) ?? 5_000
      const budgetLeft = totalWaitMs - waited
      const deadlineLeft = opts.deadlineMs == null ? Infinity : opts.deadlineMs - Date.now()
      if (wait > Math.min(budgetLeft, deadlineLeft)) throw e
      waited += wait
      await sleep(wait)
    }
  }
}
