/**
 * Outbound payment policy for agents that can pay x402 sellers.
 *
 * Two independent brakes, both enforced before a single token leaves the
 * platform wallet:
 *
 *  1. Seller allowlist — an empty list denies every payment (fail closed).
 *     A URL pays only when its host matches an allowlist entry exactly, or
 *     matches a "*." wildcard entry for one or more subdomain levels.
 *  2. Per-call cap — the smallest of the agent's configured cap, the caller's
 *     requested cap, and a hard platform ceiling.
 *
 * Rationale: a per-run budget alone does not stop a loop, because each paid
 * call can sit far below the run budget while repeating until it drains.
 */

/** Hard platform ceiling per paid call, in USD micros ($1.00). */
export const HARD_PER_CALL_CAP_MICROS = 1_000_000
/** Default when an agent has not configured a cap ($0.02). */
export const DEFAULT_PER_CALL_CAP_MICROS = 20_000

export type SellerCheck = { ok: true; host: string } | { ok: false; host: string; reason: string }

export function parseSellerHost(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

function normalizeEntry(entry: string): string {
  return entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

export function checkSellerAllowed(rawUrl: string, allowedSellers: string[] | null | undefined): SellerCheck {
  const host = parseSellerHost(rawUrl)
  if (!host) return { ok: false, host: '', reason: 'URL must be http(s)' }

  const entries = (allowedSellers ?? []).map(normalizeEntry).filter(Boolean)
  if (entries.length === 0) {
    return { ok: false, host, reason: 'No sellers allowlisted for this agent; payments are disabled' }
  }

  for (const entry of entries) {
    if (entry === host) return { ok: true, host }
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return { ok: true, host }
    }
  }
  return { ok: false, host, reason: `Seller ${host} is not on the allowlist` }
}

/** Effective per-call cap: min(agent cap, requested cap, platform ceiling). */
export function effectivePerCallCapMicros(agentCap?: number | null, requestedCap?: number | null): number {
  const candidates = [agentCap ?? DEFAULT_PER_CALL_CAP_MICROS, requestedCap ?? HARD_PER_CALL_CAP_MICROS, HARD_PER_CALL_CAP_MICROS]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
  return candidates.length ? Math.min(...candidates) : DEFAULT_PER_CALL_CAP_MICROS
}
