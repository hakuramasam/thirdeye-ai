/**
 * Ask a partner to verify an x402 payment our agent made, and report the answer.
 *
 * Two rules matter here:
 *  1. Verification never fails the run. A partner being down must not break a
 *     payment that already settled onchain.
 *  2. replay=true is proof the transaction was already accounted for, not an
 *     error. It is recorded as its own status so it can never look like a failure.
 */
export type VerifyStatus = 'verified' | 'replay' | 'unverified' | 'skipped' | 'unavailable'

export type VerifyResult = {
  status: VerifyStatus
  verifiedOnchain: boolean
  confirmations: number
  replay: boolean
  raw: Record<string, unknown>
}

export const DEFAULT_VERIFY_URL = 'https://vesper-mcp-gateway.layer2.workers.dev/verify'

export function classifyVerification(body: any): VerifyResult {
  const d = body?.data ?? body?.result ?? body ?? {}
  const replay = d.replay === true
  const verified = d.verified === true || d.verified_onchain === true
  const confirmations = Number(d.confirmations ?? d.confirmation_count ?? 0) || 0
  // A replay is treated as proof of prior accounting, never as a failure.
  const status: VerifyStatus = replay ? 'replay' : verified ? 'verified' : 'unverified'
  return {
    status,
    verifiedOnchain: replay || verified,
    confirmations,
    replay,
    raw: (d && typeof d === 'object' ? d : {}) as Record<string, unknown>,
  }
}

/** Pull a 32 byte tx hash out of an x402 payment response header or object. */
export function txHashFrom(decoded: any, header?: string | null): string | null {
  const candidates = [decoded?.transaction, decoded?.txHash, decoded?.tx_hash, decoded?.hash]
  for (const c of candidates) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]{64}$/.test(c)) return c.toLowerCase()
  }
  if (header) {
    const m = /0x[0-9a-fA-F]{64}/.exec(header)
    if (m) return m[0].toLowerCase()
  }
  return null
}

export async function verifyPayment(input: {
  txHash: string | null
  chain?: string
  method?: string
  expected?: Record<string, unknown>
  url?: string
  timeoutMs?: number
}): Promise<VerifyResult> {
  if (!input.txHash) {
    return { status: 'skipped', verifiedOnchain: false, confirmations: 0, replay: false, raw: { reason: 'no tx hash on the payment response' } }
  }
  const url = input.url || process.env.PARTNER_VERIFY_URL || DEFAULT_VERIFY_URL
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tx_hash: input.txHash,
        chain: input.chain ?? 'base',
        method: input.method ?? 'x402',
        expected: input.expected ?? {},
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 6000),
    })
    const text = await res.text()
    let body: any = {}
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
    // Some verifiers answer 402 as a STATUS ("not verified") rather than a payment
    // demand, and still return a full on-chain result. Judge by the payload, not the
    // status code, so real evidence is never thrown away. Measured on Vesper's
    // verifier 2026-11-07: HTTP 402 with confirmations, block and sender populated
    // and no payment requirements attached.
    const RESULT_FIELDS = ['verified_onchain', 'verified', 'confirmations', 'exact_method', 'tx_hash', 'block']
    const looksLikeResult = body && typeof body === 'object' && RESULT_FIELDS.some((f) => f in body)
    if (looksLikeResult) return classifyVerification(body)
    if (!res.ok) {
      return { status: 'unavailable', verifiedOnchain: false, confirmations: 0, replay: false, raw: { http: res.status, body } }
    }
    return classifyVerification(body)
  } catch (e: any) {
    return { status: 'unavailable', verifiedOnchain: false, confirmations: 0, replay: false, raw: { error: String(e?.message || e).slice(0, 200) } }
  }
}
