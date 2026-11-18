/**
 * THIRDEYE premint schedules, recorded from the token contract on 2026-11-17 and immutable since.
 *
 * These are a copy of onchain state, not the authority. The authority is
 * `releaseFor(beneficiary, scheduleId, amount)` on the token contract, which anyone may call and
 * which always pays the treasury vault. If this file and the chain disagree, the chain is right.
 */

import type { ScheduleInput } from '../payments/tokenStatus.js'

export const VESTING_START = '2026-11-12T06:03:24.000Z'

/** Labels follow the launch plan's buckets. Promo and platform airdrops merged into one schedule. */
export const PREMINT_SCHEDULES: ScheduleInput[] = [
  { id: '0', label: 'treasury reserve', amount: 220_000_000, start: VESTING_START, cliffEnd: '2027-02-10T06:03:24.000Z', end: '2027-02-10T06:03:24.000Z' },
  { id: '1', label: 'promo and platform airdrops', amount: 110_000_000, start: VESTING_START, cliffEnd: '2026-12-12T06:03:24.000Z', end: '2026-12-12T06:03:24.000Z' },
  { id: '2', label: 'community', amount: 140_000_000, start: VESTING_START, cliffEnd: '2026-12-12T06:03:24.000Z', end: '2027-06-05T06:03:24.000Z' },
  { id: '3', label: 'early member airdrop', amount: 70_000_000, start: VESTING_START, cliffEnd: '2026-12-12T06:03:24.000Z', end: '2027-12-07T06:03:24.000Z' },
  { id: '4', label: 'dev and ops', amount: 180_000_000, start: VESTING_START, cliffEnd: '2027-05-11T06:03:24.000Z', end: '2029-05-08T06:03:24.000Z' },
  { id: '5', label: 'partner', amount: 80_000_000, start: VESTING_START, cliffEnd: '2027-02-10T06:03:24.000Z', end: '2028-02-05T06:03:24.000Z' },
]
