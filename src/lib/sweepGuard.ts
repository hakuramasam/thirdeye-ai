/**
 * Guards for moving the deployed token airdrop out of the hot deployer wallet
 * into the passkey-controlled treasury vault.
 *
 * The sweep is two signed transactions by the deployer key: claim the airdrop,
 * then transfer the balance to the treasury. These guards exist so a scripted or
 * automated sweep cannot move funds to the wrong place, run twice over a stale
 * balance, or burn the only gas it has on a transfer that cannot succeed.
 */

export type SweepPlanInput = {
  tokenAddress?: string | null
  deployer: string
  treasury: string
  balanceWei: bigint
  gasBalanceEth: number
  minGasEth?: number
  reserveFloorWei?: bigint
}

export type SweepPlan = {
  ok: boolean
  reasons: string[]
  warnings: string[]
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function planSweep(input: SweepPlanInput): SweepPlan {
  const reasons: string[] = []
  const warnings: string[] = []
  const minGas = input.minGasEth ?? 0.0005

  if (!input.tokenAddress || !ADDRESS.test(input.tokenAddress)) {
    reasons.push('token address is missing or malformed')
  }
  if (!ADDRESS.test(input.deployer)) reasons.push('deployer address is missing or malformed')
  if (!ADDRESS.test(input.treasury)) reasons.push('treasury address is missing or malformed')

  // Sending to the same wallet would burn gas and change nothing.
  if (input.deployer.toLowerCase() === input.treasury.toLowerCase()) {
    reasons.push('treasury and deployer are the same wallet')
  }

  if (input.balanceWei <= 0n) reasons.push('deployer holds no tokens to sweep')

  // A sweep that cannot pay for itself leaves the tokens where they were.
  if (input.gasBalanceEth < minGas) {
    reasons.push(`deployer gas balance ${input.gasBalanceEth} ETH is below the ${minGas} ETH minimum`)
  }

  const floor = input.reserveFloorWei ?? 0n
  if (floor > 0n && input.balanceWei > 0n && input.balanceWei - floor <= 0n) {
    reasons.push('balance does not exceed the reserve floor')
  }
  if (floor > 0n && input.balanceWei > floor) {
    warnings.push(`sweeping ${(input.balanceWei - floor).toString()} of ${input.balanceWei.toString()} base units, keeping the reserve floor`)
  }

  return { ok: reasons.length === 0, reasons, warnings }
}

/** Tokens to actually move, once guards pass. */
export function sweepAmount(balanceWei: bigint, reserveFloorWei = 0n): bigint {
  const amount = balanceWei - reserveFloorWei
  return amount > 0n ? amount : 0n
}
