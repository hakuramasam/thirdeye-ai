import { one, query } from '../db/index.js'

export type RateLimitResult = {
  ok: boolean
  rpm_used: number
  tpm_used: number
  rpm_limit: number
  tpm_limit: number
  reset_seconds: number
}

/**
 * Fixed-window rate limiter, per API key (RPM = requests/min, TPM = estimated
 * tokens/min). Atomic upsert; returns ok=false when a limit would be exceeded.
 */
export async function checkAndConsume(
  apiKeyId: string,
  rpmLimit: number,
  tpmLimit: number,
  estTokens: number
): Promise<RateLimitResult> {
  const windowStart = new Date()
  windowStart.setSeconds(0, 0)
  const resetSeconds = 60 - Math.floor((Date.now() % 60000) / 1000)

  const res = await one(
    `INSERT INTO ratelimit_counters (api_key_id, window_start, rpm_count, tpm_count)
     VALUES ($1, $2::timestamptz, 1, $3)
     ON CONFLICT (api_key_id) DO UPDATE SET
       rpm_count = CASE WHEN ratelimit_counters.window_start = $2::timestamptz THEN ratelimit_counters.rpm_count + 1 ELSE 1 END,
       tpm_count = CASE WHEN ratelimit_counters.window_start = $2::timestamptz THEN ratelimit_counters.tpm_count + $3 ELSE $3 END,
       window_start = $2::timestamptz
     RETURNING rpm_count, tpm_count`,
    [apiKeyId, windowStart.toISOString(), Math.max(1, estTokens)]
  )
  const rpmUsed = res?.rpm_count ?? 1
  const tpmUsed = res?.tpm_count ?? estTokens
  return {
    ok: rpmUsed <= rpmLimit && tpmUsed <= tpmLimit,
    rpm_used: rpmUsed,
    tpm_used: tpmUsed,
    rpm_limit: rpmLimit,
    tpm_limit: tpmLimit,
    reset_seconds: resetSeconds,
  }
}

/** Reset counters after a rejected/errored request so users are not charged a slot. */
export async function refundSlot(apiKeyId: string, tokens: number): Promise<void> {
  await query(
    `UPDATE ratelimit_counters SET rpm_count = GREATEST(rpm_count - 1, 0), tpm_count = GREATEST(tpm_count - $2, 0) WHERE api_key_id = $1`,
    [apiKeyId, Math.max(1, tokens)]
  )
}
