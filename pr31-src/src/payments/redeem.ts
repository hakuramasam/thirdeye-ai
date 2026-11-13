/**
 * Outbound conversion: spend prepaid credits and receive an asset in a wallet we do not control.
 *
 * This is deliberately the mirror image of autoConvert.ts, and deliberately not an autonomous
 * spender. The order of operations is:
 *
 *   1. quote    — price the payout with the same market guards used inbound
 *   2. payout   — the platform sends the asset to the user's own wallet
 *   3. settle   — only a verified outbound transfer debits credits
 *
 * Steps 2 and 3 are separate on purpose. swap.ts says plainly that a swap never executes inside a
 * request path, and payout is the one direction where a bug moves money that cannot be recalled.
 * So this module prices and reconciles; it never signs. A redemption is a claim against the
 * ledger that is only honoured once the chain proves the asset actually left.
 *
 * Refusal stays a first-class outcome here too, for the same reason it is inbound: a quote we
 * cannot defend is worse than no quote.
 */

import { createPublicClient, http, parseAbi } from 'viem'
import { DEFAULT_MARKET_POLICY, type MarketPolicy } from './market.js'
import { CHAINS } from './chains.js'

export type RedeemPolicy = {
  /** Off unless a deployment opts in. Payout is the direction that spends real money. */
  enabled: boolean
  /** Smallest redemption in USD micros. Below this the gas and attention cost more than the value. */
  minUsdMicros: number
  /** Largest single redemption in USD micros. */
  maxPerCallMicros: number
  /** Rolling daily ceiling per account, in USD micros, counting quoted and settled rows. */
  maxPerDayMicros: number
  /** Slippage floor applied to the payout, so an underpaying transfer can be refused. */
  slippageBps: number
  /** How long a quote is presented as fresh. An old quote still settles; it just is not a promise. */
  quoteTtlSeconds: number
  /** Market guards, reused verbatim from the inbound path so both directions refuse alike. */
  market: MarketPolicy
}

export function redeemPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RedeemPolicy {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  return {
    enabled: String(env.REDEEM_ENABLED ?? 'false').toLowerCase() === 'true',
    minUsdMicros: Math.round(num(env.REDEEM_MIN_USD, 5) * 1_000_000),
    maxPerCallMicros: Math.round(num(env.REDEEM_MAX_USD_PER_CALL, 50) * 1_000_000),
    maxPerDayMicros: Math.round(num(env.REDEEM_MAX_USD_PER_DAY, 100) * 1_000_000),
    slippageBps: num(env.REDEEM_SLIPPAGE_BPS, 150),
    quoteTtlSeconds: num(env.REDEEM_QUOTE_TTL_SECONDS, 600),
    market: DEFAULT_MARKET_POLICY,
  }
}

export type RedeemRefusal = { ok: false; code: string; message: string }

export function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/**
 * Every rule that can refuse a redemption before any money is discussed.
 *
 * Pure on purpose: this is the gate that decides whether a user may be promised a payout, so it
 * needs to be testable row by row without a database, an indexer or a chain.
 *
 * Note the ordering. Disabled is checked first because an unconfigured deployment must not leak
 * the state of a balance, and the balance check comes last because it is the only rule that
 * depends on the account rather than on the request.
 */
export function checkRedeemRequest(input: {
  amountUsdMicros: number
  balanceMicros: number
  dailySpentMicros: number
  policy: RedeemPolicy
}): { ok: true } | RedeemRefusal {
  const { amountUsdMicros, balanceMicros, dailySpentMicros, policy } = input

  if (!policy.enabled) {
    return { ok: false, code: 'redeem_disabled', message: 'Redemptions are disabled on this deployment' }
  }
  if (!Number.isInteger(amountUsdMicros) || amountUsdMicros <= 0) {
    return { ok: false, code: 'invalid_amount', message: 'amount_usd_micros must be a positive whole number of micros' }
  }
  if (amountUsdMicros < policy.minUsdMicros) {
    return { ok: false, code: 'below_minimum', message: `The smallest redemption is ${usd(policy.minUsdMicros)}` }
  }
  if (amountUsdMicros > policy.maxPerCallMicros) {
    return { ok: false, code: 'above_per_call_cap', message: `A single redemption is capped at ${usd(policy.maxPerCallMicros)}` }
  }
  if (dailySpentMicros + amountUsdMicros > policy.maxPerDayMicros) {
    const left = Math.max(0, policy.maxPerDayMicros - dailySpentMicros)
    return {
      ok: false,
      code: 'daily_cap_reached',
      message: `That would pass the ${usd(policy.maxPerDayMicros)} daily ceiling; ${usd(left)} of it is left today`,
    }
  }
  if (balanceMicros < amountUsdMicros) {
    return {
      ok: false,
      code: 'insufficient_credits',
      message: `Balance is ${usd(balanceMicros)}, which does not cover a ${usd(amountUsdMicros)} redemption`,
    }
  }
  return { ok: true }
}

/**
 * The floor a payout transfer must clear.
 *
 * Mirrors minOutFromPrice() so both directions speak the same language: a transfer that lands
 * under this is an underpayment and is refused, not credited at the worse rate.
 */
export function minPayoutRaw(expectedOutRaw: bigint, slippageBps: number): bigint {
  if (expectedOutRaw <= 0n) return 0n
  const keep = 10_000n - BigInt(Math.max(0, Math.min(9_000, Math.round(slippageBps))))
  return (expectedOutRaw * keep) / 10_000n
}

/**
 * Expiry is advisory, not a refusal.
 *
 * The uncomfortable case is a payout the platform already sent, arriving after the quote aged
 * out. Refusing that would leave credits debited nowhere and the transfer unexplained, so a stale
 * quote still settles against its original floor and the caller re-quotes only to get a better
 * price. This function exists so the API can label a quote stale rather than to block settlement.
 */
export function isQuoteExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  const t = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt)
  if (!Number.isFinite(t)) return true
  return t <= now.getTime()
}

/**
 * Token decimals, asked of the contract when the registry does not know the token.
 *
 * Refusing to guess the scale is the important part: a redemption priced at 10^9 when the token
 * uses 10^18 pays out a billionth of the intended amount, and 18 is the wrong answer often enough
 * to matter.
 */
export async function readTokenDecimals(chainId: number, token: string): Promise<number | null> {
  const cfg = CHAINS.find((c) => c.chainId === chainId)
  if (!cfg) return null
  const registered = cfg.tokens.find((t) => t.address.toLowerCase() === String(token).toLowerCase())
  if (registered) return registered.decimals

  try {
    const client = createPublicClient({ transport: http(cfg.rpc) })
    const dec = await client.readContract({
      address: token as `0x${string}`,
      abi: parseAbi(['function decimals() view returns (uint8)']),
      functionName: 'decimals',
    })
    const n = Number(dec)
    if (!Number.isFinite(n) || n < 0 || n > 36) return null
    return n
  } catch {
    return null
  }
}
