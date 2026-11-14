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

/**
 * An ignored override is a configuration fault the operator cannot see otherwise, so it is reported
 * once per setting rather than per request. The token is redacted: this only ever holds a number.
 */
const rejectedOverrides = new Set<string>()

function warnRejectedOverride(key: string, raw: string, fallback: number): void {
  const token = `${key}=${raw}`
  if (rejectedOverrides.has(token)) return
  rejectedOverrides.add(token)
  // eslint-disable-next-line no-console
  console.warn(
    `[finality] ${key}="${raw}" is not a positive integer; the ${fallback}-confirmation default is in force.`
  )
}

/** Per-chain confirmation requirement, overridable with FINALITY_CONFIRMATIONS_<CHAIN>. */
export function finalityPolicy(
  chainId: number,
  env: Record<string, string | undefined> = process.env
): FinalityPolicy {
  const base = DEFAULTS[chainId] ?? FALLBACK
  const key = `FINALITY_CONFIRMATIONS_${base.label.toUpperCase()}`
  const raw = env[key]
  // An override is only honoured when it is a plain positive safe integer. `Number('')` is 0 and
  // `Math.floor('0.5')` is 0, so a loose parse let a typo switch the confirmation gate off
  // entirely, which is the one value that must never be reachable by accident. Digits alone are
  // not enough either: `Number('9'.repeat(400))` is Infinity, and an infinite requirement would
  // leave every deposit waiting for a depth that can never be reached.
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  const usable = Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
  if (raw !== undefined && usable === null) warnRejectedOverride(key, String(raw), base.min)
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
  observedBlock: number | null
  /** Set when the depth could not be measured at all, so the caller can explain the wait. */
  unverifiable?: 'missing_receipt_block' | 'unreadable_head'
}

export function finalityVerdict(input: {
  chainId: number
  /** `null`/`undefined` when the receipt carries no inclusion block: depth is then unknowable. */
  receiptBlock: bigint | number | null | undefined
  headBlock: bigint | number
  env?: Record<string, string | undefined>
}): FinalityVerdict {
  const policy = finalityPolicy(input.chainId, input.env ?? process.env)
  // A receipt with no block number used to be read as block 0, so any head looked like a
  // million-deep confirmation and the gate opened on nothing. An unmeasurable receipt is zero
  // confirmations and a wait, which is the only safe answer.
  if (input.receiptBlock === null || input.receiptBlock === undefined) {
    return {
      state: 'confirming',
      confirmations: 0,
      required: policy.minConfirmations,
      observedBlock: null,
      unverifiable: 'missing_receipt_block',
    }
  }
  const confirmations = confirmationsFor(input.receiptBlock, input.headBlock)
  return {
    state: confirmations >= policy.minConfirmations ? 'confirmed' : 'confirming',
    confirmations,
    required: policy.minConfirmations,
    observedBlock: Number(input.receiptBlock),
  }
}

/** The only states a deposit may still move to `credited` from. */
export const CREDITABLE_STATES = new Set(['detected', 'confirming', 'confirmed'])

/** The same whitelist as a guard, shared with the settlement write so both agree. */
export function shouldCreditOnTransition(state?: string | null): boolean {
  return CREDITABLE_STATES.has(String(state ?? 'detected'))
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
  // Whitelist, not blacklist. A state this function does not know about is a state nobody has
  // decided how to settle, so it waits for a human instead of falling through to a credit.
  if (!CREDITABLE_STATES.has(state)) {
    return { action: 'refuse', reason: 'needs_reconciliation' }
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
