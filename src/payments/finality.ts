/**
 * Deposit finality policy.
 *
 * A receipt at one confirmation is not money: the block can still be replaced. Every settle path
 * therefore asks this module two questions — how many confirmations this chain requires, and what
 * to do with a payment in its current state — so the rule lives in one place instead of being
 * spread across the claim, conversion and admin routes.
 *
 * The defaults are deliberately conservative. Finality is measured on block depth because it is
 * the only signal every EVM chain we support exposes through the same RPC call.
 */

export type PaymentState =
  | 'detected'
  | 'confirming'
  | 'confirmed'
  | 'credited'
  | 'reorged'
  | 'rejected'
  | 'needs_reconciliation'

const DEFAULTS: Record<number, { min: number; label: string }> = {
  8453: { min: 10, label: 'base' },
  56: { min: 15, label: 'bsc' },
  4663: { min: 10, label: 'robinhood' },
}
const FALLBACK = { min: 12, label: 'unknown' }

export type FinalityPolicy = {
  chainId: number
  label: string
  minConfirmations: number
  source: 'default' | 'env'
}

/** Per-chain confirmation requirement, overridable with FINALITY_CONFIRMATIONS_<CHAIN>. */
export function finalityPolicy(
  chainId: number,
  env: Record<string, string | undefined> = process.env
): FinalityPolicy {
  const base = DEFAULTS[chainId] ?? FALLBACK
  const raw = env[`FINALITY_CONFIRMATIONS_${base.label.toUpperCase()}`]
  const parsed = raw === undefined ? NaN : Number(raw)
  const usable = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
  return {
    chainId,
    label: base.label,
    minConfirmations: usable ?? base.min,
    source: usable === null ? 'default' : 'env',
  }
}

/** Block depth of a receipt, counting the block it landed in as the first confirmation. */
export function confirmationsFor(receiptBlock: bigint | number, headBlock: bigint | number): number {
  const receipt = BigInt(receiptBlock)
  const head = BigInt(headBlock)
  if (head < receipt) return 0
  const depth = head - receipt + 1n
  return depth > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(depth)
}

export type FinalityVerdict = {
  state: 'confirming' | 'confirmed'
  confirmations: number
  required: number
  observedBlock: number
}

export function finalityVerdict(input: {
  chainId: number
  receiptBlock: bigint | number
  headBlock: bigint | number
  env?: Record<string, string | undefined>
}): FinalityVerdict {
  const policy = finalityPolicy(input.chainId, input.env ?? process.env)
  const confirmations = confirmationsFor(input.receiptBlock, input.headBlock)
  return {
    state: confirmations >= policy.minConfirmations ? 'confirmed' : 'confirming',
    confirmations,
    required: policy.minConfirmations,
    observedBlock: Number(input.receiptBlock),
  }
}

export type SettlementDecision =
  | { action: 'credit'; confirmations: number; required: number }
  | { action: 'wait'; reason: 'insufficient_confirmations'; confirmations: number; required: number }
  | { action: 'already_credited' }
  | { action: 'refuse'; reason: 'reorged' | 'rejected' | 'needs_reconciliation' }

/**
 * What a settle attempt should do, given the stored state and the online evidence.
 *
 * Order matters: a payment that was credited and then reorged must never be credited again, and a
 * payment flagged for reconciliation is a human decision, not something a retry can resolve.
 */
export function decideSettlement(input: {
  state?: string | null
  confirmations: number
  required: number
}): SettlementDecision {
  const state = String(input.state ?? 'detected')
  if (state === 'credited') return { action: 'already_credited' }
  if (state === 'reorged' || state === 'rejected' || state === 'needs_reconciliation') {
    return { action: 'refuse', reason: state }
  }
  if (input.confirmations < input.required) {
    return {
      action: 'wait',
      reason: 'insufficient_confirmations',
      confirmations: input.confirmations,
      required: input.required,
    }
  }
  return { action: 'credit', confirmations: input.confirmations, required: input.required }
}
