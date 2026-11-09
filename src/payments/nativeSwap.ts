/**
 * Native-asset conversions (ETH on Base, BNB on BNB Smart Chain).
 *
 * Why this exists: native deposits used to be analysed but never convertible. Our own v3
 * executor routes ERC-20 pools only, so a native asset was accepted by the pricing gate and
 * then refused at execution, which is exactly the "stuck ETH / stuck BNB" state. Privy can
 * swap a native asset directly (`asset_address: "native"`), so natives go through Privy's
 * swap engine instead of our v3 router. Nothing else changes: the credit is still the
 * stablecoin actually measured in the wallet afterwards, never the quoted number.
 */

import { CHAINS } from './chains.js'
import { authorizationHeaders, type PrivyAuthEnv } from './privyAuth.js'

export type NativeRail = {
  caip2: string
  symbol: string
  /** What the native asset is converted into, i.e. the chain's settlement stablecoin. */
  settlement: { address: string; symbol: string; decimals: number }
}

function railFor(chainId: number): NativeRail | null {
  const chain = CHAINS.find((c) => c.chainId === chainId)
  if (!chain) return null
  const caip2 = chainId === 56 ? 'eip155:56' : chainId === 8453 ? 'eip155:8453' : null
  if (!caip2) return null
  return {
    caip2,
    symbol: chainId === 56 ? 'BNB' : 'ETH',
    settlement: {
      address: chain.settlement.address,
      symbol: chain.settlement.symbol,
      decimals: chain.settlement.decimals,
    },
  }
}

/**
 * Native assets arrive as the zero address (Uniswap v4 and GeckoTerminal both use it for the
 * native coin), as an explicit "native", or as an empty string when a caller omitted a token.
 */
export function isNativeAsset(chainId: number, tokenAddress: string): boolean {
  const addr = String(tokenAddress ?? '').trim().toLowerCase()
  if (!addr || addr === 'native' || addr === 'eth' || addr === 'bnb') return Boolean(railFor(chainId))
  if (/^0x0{40}$/.test(addr)) return Boolean(railFor(chainId))
  return false
}

export function nativeRail(chainId: number): NativeRail | null {
  return railFor(chainId)
}

export function privyEnvFromEnv(env: NodeJS.ProcessEnv = process.env): PrivyAuthEnv | null {
  const appId = env.PRIVY_APP_ID
  const appSecret = env.PRIVY_APP_SECRET
  const walletId = env.PRIVY_WALLET_ID
  if (!appId || !appSecret || !walletId) return null
  return {
    appId,
    appSecret,
    walletId,
    authorizationKeyId: env.PRIVY_AUTHORIZATION_KEY_ID,
    authorizationPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
  }
}

export type NativeQuote =
  | { ok: true; estOutAmount: bigint; minimumOutAmount: bigint; gasEstimate: bigint | null }
  | { ok: false; code: string; message: string }

function basicAuth(auth: PrivyAuthEnv): string {
  return 'Basic ' + Buffer.from(`${auth.appId}:${auth.appSecret}`).toString('base64')
}

/** Ask Privy what a native swap would return. Read-only: no funds move. */
export async function quoteNativeSwap(params: {
  chainId: number
  amountRaw: bigint
  auth?: PrivyAuthEnv | null
}): Promise<NativeQuote> {
  const rail = railFor(params.chainId)
  if (!rail) return { ok: false, code: 'native_unsupported_chain', message: `No native conversion rail for chain ${params.chainId}` }
  const auth = params.auth ?? privyEnvFromEnv()
  if (!auth) return { ok: false, code: 'privy_not_configured', message: 'Privy credentials are not configured for native conversions' }
  if (params.amountRaw <= 0n) return { ok: false, code: 'amount_too_large', message: 'Native amount must be greater than zero' }

  const path = `/v1/wallets/${auth.walletId}/swap/quote`
  const body = {
    source: { caip2: rail.caip2, asset_address: 'native' },
    destination: { asset_address: rail.settlement.address },
    base_amount: params.amountRaw.toString(),
    amount_type: 'exact_input',
  }
  let res: Response
  try {
    res = await fetch(`https://api.privy.io${path}`, {
      method: 'POST',
      headers: { ...authorizationHeaders(auth, { method: 'POST', path, body }), authorization: basicAuth(auth) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
  } catch (e: any) {
    return { ok: false, code: 'native_quote_unavailable', message: `Privy quote failed: ${String(e?.message ?? e).slice(0, 120)}` }
  }
  const json: any = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = String(json?.error ?? json?.message ?? res.status).slice(0, 160)
    // A provider that has no route is a refusal we own, not a crash.
    return { ok: false, code: res.status === 404 ? 'native_no_route' : 'native_quote_refused', message: `Privy refused the native quote: ${detail}` }
  }
  const est = BigInt(String(json?.est_output_amount ?? '0'))
  const min = BigInt(String(json?.minimum_output_amount ?? json?.est_output_amount ?? '0'))
  if (est <= 0n) return { ok: false, code: 'native_no_route', message: 'Privy returned no output for this native asset' }
  return { ok: true, estOutAmount: est, minimumOutAmount: min, gasEstimate: json?.gas_estimate ? BigInt(String(json.gas_estimate)) : null }
}

export type NativeExecution =
  | { ok: true; actionId: string; status: string }
  | { ok: false; code: string; message: string }

/**
 * Execute the native swap inside the Privy wallet and wait for the action to settle.
 * Privy submits the transaction itself, so no approval step and no local signing is involved.
 */
export async function executeNativeSwap(params: {
  chainId: number
  amountRaw: bigint
  auth?: PrivyAuthEnv | null
  timeoutMs?: number
  pollMs?: number
}): Promise<NativeExecution> {
  const rail = railFor(params.chainId)
  if (!rail) return { ok: false, code: 'native_unsupported_chain', message: `No native conversion rail for chain ${params.chainId}` }
  const auth = params.auth ?? privyEnvFromEnv()
  if (!auth) return { ok: false, code: 'privy_not_configured', message: 'Privy credentials are not configured for native conversions' }

  const path = `/v1/wallets/${auth.walletId}/swap`
  const body = {
    source: { caip2: rail.caip2, asset_address: 'native' },
    destination: { asset_address: rail.settlement.address },
    base_amount: params.amountRaw.toString(),
    amount_type: 'exact_input',
  }
  let res: Response
  try {
    res = await fetch(`https://api.privy.io${path}`, {
      method: 'POST',
      headers: {
        ...authorizationHeaders(auth, { method: 'POST', path, body, idempotencyKey: `native-${params.chainId}-${params.amountRaw}-${Date.now()}` }),
        authorization: basicAuth(auth),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
  } catch (e: any) {
    return { ok: false, code: 'native_swap_unavailable', message: `Privy swap request failed: ${String(e?.message ?? e).slice(0, 120)}` }
  }
  const json: any = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = String(json?.error ?? json?.message ?? res.status).slice(0, 160)
    return { ok: false, code: 'native_swap_refused', message: `Privy refused the native swap: ${detail}` }
  }
  const actionId = String(json?.id ?? '')
  if (!actionId) return { ok: false, code: 'native_swap_refused', message: 'Privy returned no action id for the native swap' }

  const deadline = Date.now() + (params.timeoutMs ?? 90_000)
  const pollMs = params.pollMs ?? 3_000
  let status = String(json?.status ?? 'pending')
  while (Date.now() < deadline) {
    if (status === 'succeeded') return { ok: true, actionId, status }
    if (status === 'failed' || status === 'rejected') {
      return { ok: false, code: `native_swap_${status}`, message: `Privy reported the native swap as ${status}` }
    }
    await new Promise((r) => setTimeout(r, pollMs))
    const actionPath = `/v1/wallets/${auth.walletId}/actions/${actionId}`
    // Reading an action is a plain authenticated read, like any other GET on the wallet.
    const poll = await fetch(`https://api.privy.io${actionPath}`, {
      headers: { authorization: basicAuth(auth), 'privy-app-id': auth.appId },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null)
    if (!poll || !poll.ok) continue
    const latest: any = await poll.json().catch(() => null)
    status = String(latest?.status ?? status)
  }
  return { ok: false, code: 'native_swap_timeout', message: `Native swap ${actionId} still ${status} after the wait window` }
}

/** Read an ERC-20 balance with eth_call, so no extra dependency is needed on non-Base chains. */
export async function readErc20Balance(chainId: number, token: string, owner: string): Promise<bigint | null> {
  const chain = CHAINS.find((c) => c.chainId === chainId)
  if (!chain) return null
  const data = '0x70a08231' + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const res = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
    signal: AbortSignal.timeout(12000),
  }).catch(() => null)
  const json: any = await res?.json().catch(() => null)
  const hex = json?.result
  if (typeof hex !== 'string' || !hex.startsWith('0x') || hex === '0x') return null
  return BigInt(hex)
}

/** Scale a raw stablecoin amount to micro-dollars using that token's real decimals. */
export function toMicros(raw: bigint, decimals: number): number {
  if (raw <= 0n) return 0
  const d = Math.max(0, Math.min(36, Math.trunc(decimals)))
  if (d === 6) return Number(raw)
  if (d > 6) return Number(raw / 10n ** BigInt(d - 6))
  return Number(raw * 10n ** BigInt(6 - d))
}
