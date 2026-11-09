/**
 * Deposit credit policy.
 *
 * The rule this enforces: we only issue spendable USD for value we actually hold in a
 * settlement stablecoin. A volatile token arriving at the treasury is an asset, not money;
 * crediting its oracle value means the user spends USD while we keep something we may not be
 * able to sell. So a volatile token earns credit only after a swap has settled and the
 * realised stablecoin amount is known, and never more than either the realised amount or the
 * oracle valuation at the time of the claim.
 */
import { CHAINS } from '../payments/chains.js'

export type CreditDecision = {
  creditMicros: number
  status: 'credited' | 'pending_conversion' | 'zero_value'
  reason: string
  /** True when the token is the chain's settlement stablecoin and needs no swap. */
  settlement: boolean
}

/** Is this token the settlement stablecoin for the chain? Address comparison is case-insensitive. */
export function isSettlementToken(chainSlug: string, token: string): boolean {
  // CHAINS is an array of chain configs keyed by `id`, not a map.
  const chain = CHAINS.find((c: any) => c.id === chainSlug || String(c.chainId) === String(chainSlug))
  const settlement = chain?.settlement?.address
  if (!settlement || !token) return false
  return String(token).toLowerCase() === String(settlement).toLowerCase()
}

/**
 * Decide how much credit a claimed payment earns. Pure, so every branch is testable.
 *
 * - oracleMicros: the valuation of the received token at claim time.
 * - realisedMicros: settlement stablecoin actually received from a settled swap, if any.
 */
export function decideCredit(input: {
  chainSlug: string
  token: string
  oracleMicros: number
  realisedMicros?: number | null
}): CreditDecision {
  const oracle = Math.max(0, Math.floor(Number(input.oracleMicros) || 0))
  const realisedRaw = input.realisedMicros == null ? null : Math.max(0, Math.floor(Number(input.realisedMicros)))
  const settlement = isSettlementToken(input.chainSlug, input.token)

  if (settlement) {
    if (oracle <= 0) return { creditMicros: 0, status: 'zero_value', reason: 'valued at zero', settlement }
    // Face value is what we hold; still never more than the oracle valuation.
    return { creditMicros: oracle, status: 'credited', reason: 'settlement stablecoin received', settlement }
  }

  if (realisedRaw == null) {
    return {
      creditMicros: 0,
      status: 'pending_conversion',
      reason: 'volatile token received; credit waits for the swap to settle',
      settlement,
    }
  }
  if (realisedRaw <= 0) {
    return { creditMicros: 0, status: 'zero_value', reason: 'swap realised nothing', settlement }
  }
  const credit = oracle > 0 ? Math.min(realisedRaw, oracle) : realisedRaw
  return {
    creditMicros: credit,
    status: 'credited',
    reason: oracle > 0 && realisedRaw > oracle ? 'credited realised amount, capped at oracle valuation' : 'credited realised swap proceeds',
    settlement,
  }
}
