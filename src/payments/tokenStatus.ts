/**
 * Read-only status for the platform token, assembled from facts we can name the source of.
 *
 * Every figure carries where it came from. A price we have not read is null with a reason, never
 * zero and never a guess: a wrong price in a public status field is worse than a missing one,
 * because it becomes the number somebody quotes back at us.
 */

export type ScheduleInput = {
  /** Onchain schedule id, as releaseFor takes it. */
  id: string
  label: string
  /** Tokens in the schedule, in whole tokens (not raw units). */
  amount: number
  /** ISO timestamps recorded from the token contract. */
  start: string
  cliffEnd: string
  end: string
}

export type FeeCheck = { pendingWeth: number; lastCollectedWeth: number; block: number | null; at: string | null }

export type TokenStatusInput = {
  symbol: string
  address: string
  decimals: number
  /** Total supply in whole tokens. */
  supply: number
  premintHeld: number
  poolAddress: string | null
  poolLocked: boolean | null
  priceUsd: number | null
  priceEth: number | null
  priceSource: string | null
  schedules: ScheduleInput[]
  fees: FeeCheck | null
  now: Date
}

export type ScheduleStatus = ScheduleInput & {
  availableNow: number
  remaining: number
  fullyAvailableAt: string
  state: 'cliff' | 'releasing' | 'released'
}

export type TokenStatus = {
  as_of: string
  token: { symbol: string; address: string; decimals: number; supply: number }
  pool: { address: string | null; locked: boolean | null }
  valuation: {
    price_usd: number | null
    price_eth: number | null
    fdv_usd: number | null
    source: string | null
    /** Present only when a figure could not be stated, saying why. */
    unavailable_reason: string | null
  }
  premint: {
    total: number
    held: number
    released: number
    available_now: number
    locked_now: number
    next_unlock: { schedule_id: string; label: string; amount: number; at: string; in_days: number } | null
    schedules: ScheduleStatus[]
  }
  fees: FeeCheck | null
}

const day = 86_400_000

/** Doppler releases nothing before the cliff, then linearly from vesting start to end. */
export function availabilityAt(s: ScheduleInput, now: Date): number {
  const start = Date.parse(s.start)
  const cliff = Date.parse(s.cliffEnd)
  const end = Date.parse(s.end)
  const t = now.getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  if (t < cliff) return 0
  if (t >= end) return s.amount
  return Math.min(s.amount, (s.amount * (t - start)) / (end - start))
}

export function scheduleStatus(s: ScheduleInput, now: Date): ScheduleStatus {
  const availableNow = availabilityAt(s, now)
  const state: ScheduleStatus['state'] =
    Date.parse(now.toISOString()) < Date.parse(s.cliffEnd) ? 'cliff' : availableNow >= s.amount ? 'released' : 'releasing'
  return { ...s, availableNow, remaining: Math.max(0, s.amount - availableNow), fullyAvailableAt: s.end, state }
}

/** The soonest schedule that still has something to give, by the date it starts giving it. */
export function nextUnlock(statuses: ScheduleStatus[], now: Date): TokenStatus['premint']['next_unlock'] {
  const future = statuses.filter((s) => s.remaining > 0 && Date.parse(s.cliffEnd) > now.getTime())
  if (!future.length) return null
  const soonest = future.reduce((a, b) => (Date.parse(a.cliffEnd) <= Date.parse(b.cliffEnd) ? a : b))
  return {
    schedule_id: soonest.id,
    label: soonest.label,
    amount: soonest.amount,
    at: soonest.cliffEnd,
    in_days: Math.max(0, Math.round((Date.parse(soonest.cliffEnd) - now.getTime()) / day)),
  }
}

export function computeTokenStatus(i: TokenStatusInput): TokenStatus {
  const statuses = i.schedules.map((s) => scheduleStatus(s, i.now)).sort((a, b) => Date.parse(a.cliffEnd) - Date.parse(b.cliffEnd))
  const availableNow = statuses.reduce((n, s) => n + s.availableNow, 0)
  const total = statuses.reduce((n, s) => n + s.amount, 0)
  const hasPrice = typeof i.priceUsd === 'number' && Number.isFinite(i.priceUsd) && i.priceUsd > 0
  return {
    as_of: i.now.toISOString(),
    token: { symbol: i.symbol, address: i.address, decimals: i.decimals, supply: i.supply },
    pool: { address: i.poolAddress, locked: i.poolLocked },
    valuation: {
      price_usd: hasPrice ? i.priceUsd : null,
      price_eth: typeof i.priceEth === 'number' && i.priceEth > 0 ? i.priceEth : null,
      fdv_usd: hasPrice ? i.priceUsd! * i.supply : null,
      source: hasPrice ? i.priceSource : null,
      unavailable_reason: hasPrice ? null : (i.priceSource === null ? 'no_market_read' : 'market_read_unusable'),
    },
    premint: {
      total,
      held: i.premintHeld,
      released: Math.max(0, total - i.premintHeld),
      available_now: availableNow,
      locked_now: Math.max(0, i.premintHeld - availableNow),
      next_unlock: nextUnlock(statuses, i.now),
      schedules: statuses,
    },
    fees: i.fees,
  }
}
