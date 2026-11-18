/**
 * Cross-chain credit funding via LI.FI (scoped in docs/lifi-cross-chain-deposits.md).
 *
 * This module only QUOTES and REPORTS. It never moves money and never credits. A bridged deposit is
 * credited by the same onchain verification as any other deposit, because a bridge answering DONE is
 * evidence of when to look, not proof that USDC arrived. Anything else would let a stalled or
 * refunded route mint spendable credit.
 */

/** Where bridged funds must land: USDC on Base, which is what the deposit verifier settles at face value. */
export const BRIDGE_DEST_CHAIN = 8453
export const BRIDGE_DEST_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

/**
 * Source chains we will quote from. Deliberately short: every entry is a route someone has to
 * support, and an unsupported route is worse than a refusal.
 */
export const BRIDGE_SOURCE_CHAINS: readonly number[] = [1, 10, 137, 42161]

/**
 * LI.FI takes a fixed fee even when the integrator fee is zero (measured 2026-11-18 at $0.025 on a
 * 10 USDC route). Below this floor the fee is a visible percentage of the deposit, which reads to a
 * user as us overcharging, so the flow refuses and explains rather than quietly shortchanging them.
 */
export const BRIDGE_MIN_USD = 25

export type BridgeFee = { name: string; amountUsd: number }
export type BridgeQuote = {
  tool: string
  fromChainId: number
  toChainId: number
  fromAmountRaw: string
  toAmountRaw: string
  toAmountMinRaw: string
  toAmountUsd: number
  executionDurationSeconds: number | null
  approvalAddress: string | null
  feeCosts: BridgeFee[]
  transactionRequest: { to: string; data: string; value: string; gasLimit?: string }
}
export type QuoteArgs = {
  fromChain: number
  fromToken: string
  fromAmountRaw: string
  fromAddress: string
  slippage?: number
}
export type QuoteDeps = {
  enabled: boolean
  apiKey: string
  fetchImpl: typeof fetch
  baseUrl?: string
}
export type QuoteResult = { ok: true; quote: BridgeQuote } | { ok: false; reason: string; detail?: string }

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const RAW_RE = /^[0-9]+$/

export function isSupportedSource(chainId: number): boolean {
  return BRIDGE_SOURCE_CHAINS.includes(chainId)
}

/** Query string for GET /v1/quote, built as data so a test can assert the exact parameters sent. */
export function buildQuoteQuery(args: QuoteArgs): Record<string, string> {
  const q: Record<string, string> = {
    fromChain: String(args.fromChain),
    toChain: String(BRIDGE_DEST_CHAIN),
    fromToken: args.fromToken,
    toToken: BRIDGE_DEST_TOKEN,
    fromAddress: args.fromAddress,
    fromAmount: args.fromAmountRaw,
  }
  if (args.slippage !== undefined) q.slippage = String(args.slippage)
  return q
}

function usd(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : 0
}

/** Map a /v1/quote body onto our own shape. Returns a refusal rather than throwing on junk. */
export function parseQuote(json: unknown): QuoteResult {
  const d = json as Record<string, any> | null
  if (!d || typeof d !== 'object') return { ok: false, reason: 'bad_response', detail: 'not an object' }
  if (!d.estimate || !d.action) {
    const msg = typeof d.message === 'string' ? d.message : 'no estimate in response'
    return { ok: false, reason: 'no_route', detail: msg.slice(0, 200) }
  }
  const tr = d.transactionRequest
  if (!tr || typeof tr.to !== 'string' || typeof tr.data !== 'string') {
    return { ok: false, reason: 'no_transaction', detail: 'quote carried no signable transaction' }
  }
  if (!ADDRESS_RE.test(tr.to)) return { ok: false, reason: 'no_transaction', detail: 'bad target address' }
  return {
    ok: true,
    quote: {
      tool: String(d.estimate.tool ?? 'unknown'),
      fromChainId: Number(d.action.fromChainId ?? 0),
      toChainId: Number(d.action.toChainId ?? 0),
      fromAmountRaw: String(d.action.fromAmount ?? ''),
      toAmountRaw: String(d.estimate.toAmount ?? ''),
      toAmountMinRaw: String(d.estimate.toAmountMin ?? ''),
      toAmountUsd: usd(d.estimate.toAmountUSD),
      executionDurationSeconds: d.estimate.executionDuration == null ? null : Number(d.estimate.executionDuration),
      approvalAddress: typeof d.estimate.approvalAddress === 'string' ? d.estimate.approvalAddress : null,
      feeCosts: Array.isArray(d.estimate.feeCosts)
        ? d.estimate.feeCosts.map((f: any) => ({ name: String(f?.name ?? 'fee'), amountUsd: usd(f?.amountUSD) }))
        : [],
      transactionRequest: {
        to: tr.to,
        data: tr.data,
        value: typeof tr.value === 'string' ? tr.value : '0x0',
        gasLimit: typeof tr.gasLimit === 'string' ? tr.gasLimit : undefined,
      },
    },
  }
}

/** /v1/status is a hint about when to look, never a credit decision. */
export function parseStatus(json: unknown): { state: 'pending' | 'done' | 'failed' | 'not_found'; substatus?: string } {
  const d = json as Record<string, any> | null
  const s = typeof d?.status === 'string' ? d.status.toUpperCase() : ''
  const sub = typeof d?.substatus === 'string' ? d.substatus : undefined
  if (s === 'DONE') return { state: 'done', ...(sub ? { substatus: sub } : {}) }
  if (s === 'FAILED') return { state: 'failed', ...(sub ? { substatus: sub } : {}) }
  if (s === 'PENDING' || s === 'NOT_FOUND') return { state: 'pending', ...(sub ? { substatus: sub } : {}) }
  return { state: 'not_found' }
}

/**
 * Ask LI.FI for a route and hand back a signable transaction for the user's own wallet. We never
 * sign it: the payer bridges from their wallet, and the destination is a platform deposit address.
 */
export async function quoteBridgeDeposit(args: QuoteArgs, deps: QuoteDeps): Promise<QuoteResult> {
  if (!deps.enabled) return { ok: false, reason: 'disabled' }
  if (!deps.apiKey) return { ok: false, reason: 'no_api_key' }
  if (!isSupportedSource(args.fromChain)) return { ok: false, reason: 'unsupported_source_chain', detail: String(args.fromChain) }
  if (!ADDRESS_RE.test(args.fromToken)) return { ok: false, reason: 'bad_source_token' }
  if (!ADDRESS_RE.test(args.fromAddress)) return { ok: false, reason: 'bad_from_address' }
  if (!RAW_RE.test(args.fromAmountRaw) || args.fromAmountRaw === '0') return { ok: false, reason: 'amount_required' }

  const base = deps.baseUrl ?? 'https://li.quest'
  const url = new URL('/v1/quote', base)
  for (const [k, v] of Object.entries(buildQuoteQuery(args))) url.searchParams.set(k, v)

  let body: unknown
  try {
    const res = await deps.fetchImpl(url.toString(), {
      headers: { 'x-lifi-api-key': deps.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 429) return { ok: false, reason: 'rate_limited' }
    body = await res.json()
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: (e instanceof Error ? e.message : String(e)).slice(0, 160) }
  }

  const parsed = parseQuote(body)
  if (!parsed.ok) return parsed
  // Refuse on the measured value, not on the requested one: the fee is taken out of the route.
  if (parsed.quote.toAmountUsd < BRIDGE_MIN_USD) {
    return { ok: false, reason: 'below_minimum', detail: `$${parsed.quote.toAmountUsd.toFixed(2)} of ${BRIDGE_MIN_USD}` }
  }
  return parsed
}
