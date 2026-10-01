/**
 * x402 (HTTP 402 pay-per-call, USDC on Base) fetch client for agents.
 *
 * Flow: plain fetch first; if the endpoint answers 402 Payment Required and a
 * platform agent wallet key is configured, retry through x402's
 * wrapFetchWithPayment, which reads the payment requirements, signs an
 * EIP-3009 USDC transfer and re-sends with the X-PAYMENT header.
 */

import { env } from '../lib/env.js'

const X402_NETWORK = 'base' // USDC payments settle on Base mainnet (chain 8453)

export type PaidFetchResult = {
  response: Response
  paid: boolean
  /** Best-effort spend in USD micros; capped at opts.maxSpendUsdMicros. */
  spentUsdMicros: number
}

type LazySigner = { wrap: typeof fetch } | null
let signerCache: LazySigner = null
let signerKeyUsed = ''

async function getWrappedFetch(maxSpendUsdMicros: number): Promise<typeof fetch | null> {
  if (!env.agentWalletKey) return null
  const { wrapFetchWithPayment, createSigner } = await import('x402-fetch')
  if (!signerCache || signerKeyUsed !== env.agentWalletKey) {
    const signer = await createSigner(X402_NETWORK, env.agentWalletKey as `0x${string}`)
    signerKeyUsed = env.agentWalletKey
    signerCache = { wrap: (input: any, init?: any) => wrapFetchWithPayment(globalThis.fetch, signer)(input as RequestInfo, init) }
  }
  // maxValue is in the token's base units; USDC has 6 decimals == USD micros 1:1.
  void maxSpendUsdMicros
  return signerCache.wrap
}

/**
 * Fetch a URL, paying its 402 invoice automatically when an agent wallet is
 * configured. Never pays more than opts.maxSpendUsdMicros per call (default
 * and hard cap: $0.10).
 */
export async function paidFetch(
  url: string,
  init?: RequestInit,
  opts: { maxSpendUsdMicros?: number } = {}
): Promise<PaidFetchResult> {
  const maxSpend = Math.min(opts.maxSpendUsdMicros ?? 10_000, 100_000) // cap $0.10/call
  let res = await fetch(url, init)
  if (res.status !== 402) return { response: res, paid: false, spentUsdMicros: 0 }

  const wrap = await getWrappedFetch(maxSpend)
  if (!wrap) {
    return { response: res, paid: false, spentUsdMicros: 0 } // 402 surfaces to the caller
  }

  const { wrapFetchWithPayment } = await import('x402-fetch')
  // Re-issue the request through x402 with a hard maxValue in base units.
  const paidRes = await wrapFetchWithPayment(globalThis.fetch, await getSigner(), BigInt(maxSpend))(url as unknown as RequestInfo, init)
  const paid = paidRes.ok
  let spentUsdMicros = 0
  try {
    const { decodeXPaymentResponse } = await import('x402-fetch')
    const header = paidRes.headers.get('x-payment-response') || ''
    const decoded = header ? decodeXPaymentResponse(header) : null
    void decoded // transaction hash available here for a future exact-spend RPC lookup
  } catch { /* best-effort */ }
  if (paid) spentUsdMicros = maxSpend // conservative: budget the cap until exact lookup
  return { response: paidRes, paid, spentUsdMicros }
}

async function getSigner(): Promise<any> {
  const { createSigner } = await import('x402-fetch')
  return createSigner(X402_NETWORK, env.agentWalletKey as `0x${string}`)
}
