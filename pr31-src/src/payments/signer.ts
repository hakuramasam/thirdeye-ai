/**
 * Who can actually move the money.
 *
 * A conversion is only possible if the token sits in a wallet this server can sign for. Two
 * mechanisms are supported and neither is required to be present: a local key
 * (AGENT_WALLET_PRIVATE_KEY) for a plain EOA, or a Privy server wallet reached over their REST
 * API with PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_WALLET_ID. When neither is configured we
 * return null with a reason instead of pretending, so a pending deposit is parked, not lost.
 */
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

export type SendTxArgs = { to: `0x${string}`; data?: `0x${string}`; value?: bigint; chainId: number }

export type Signer = {
  kind: 'local' | 'privy'
  address: `0x${string}`
  sendTransaction(args: SendTxArgs): Promise<`0x${string}`>
}

export type SignerResult = { ok: true; signer: Signer } | { ok: false; reason: string; detail: string }

import { authorizationHeaders } from './privyAuth.js'

const PRIVY_API = 'https://api.privy.io/v1'

function localSigner(key: string): Signer {
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex)
  return {
    kind: 'local',
    address: account.address,
    async sendTransaction(args) {
      const { createWalletClient, http } = await import('viem')
      const { base } = await import('viem/chains')
      const client = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org') })
      const hash = await client.sendTransaction({
        to: args.to,
        data: args.data,
        value: args.value ?? 0n,
        chain: base,
      })
      return hash
    },
  }
}

/** How Privy pays gas: our credits, the wallet's own USDC, or nothing (wallet pays ETH). */
export type SponsorMode = 'off' | 'app' | 'user' | 'auto'

export function sponsorAttempts(mode: SponsorMode): Array<{ sponsor?: true; sponsor_options?: { asset: string } }> {
  if (mode === 'app') return [{ sponsor: true }]
  if (mode === 'user') return [{ sponsor: true, sponsor_options: { asset: 'usdc' } }]
  if (mode === 'auto') {
    // App credits first because a fresh deposit holds no USDC to pay gas with, then token gas,
    // then the plain paid-in-ETH path so a wallet funded with gas keeps working.
    return [{ sponsor: true }, { sponsor: true, sponsor_options: { asset: 'usdc' } }, {}]
  }
  return [{}]
}

/** Only these mean "this payment mode is unavailable"; anything else must surface unchanged. */
function sponsorUnavailable(message: string): boolean {
  return /sponsorship is not configured|gas sponsorship is not configured/i.test(message)
}

export function privySigner(
  appId: string,
  appSecret: string,
  walletId: string,
  address: `0x${string}`,
  authorization?: { keyId?: string; privateKey?: string },
  sponsorMode: SponsorMode = 'off'
): Signer {
  const auth = 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64')

  /** Sponsored sends return a user operation, not a hash, so the hash has to be awaited. */
  async function resolveHash(body: any): Promise<`0x${string}` | null> {
    const direct = body?.data?.hash ?? body?.data?.transaction_hash ?? body?.hash
    if (direct) return direct as `0x${string}`
    const transactionId = body?.data?.transaction_id
    if (!transactionId) return null
    for (let i = 0; i < 15; i += 1) {
      const res = await fetch(`${PRIVY_API}/transactions/${transactionId}`, {
        headers: { authorization: auth, 'privy-app-id': appId },
        signal: AbortSignal.timeout(15000),
      })
      const read: any = await res.json().catch(() => null)
      const hash = read?.transaction_hash ?? read?.data?.transaction_hash ?? read?.hash
      if (hash) return hash as `0x${string}`
      await new Promise((r) => setTimeout(r, 2000))
    }
    return null
  }

  return {
    kind: 'privy',
    address,
    async sendTransaction(args) {
      const attempts = sponsorAttempts(sponsorMode)
      let lastError = ''
      for (const attempt of attempts) {
        // Privy signs eth_sendTransaction for a server wallet; the key never reaches us.
        const payload = {
          method: 'eth_sendTransaction',
          caip2: `eip155:${args.chainId}`,
          ...attempt,
          params: {
            transaction: {
              to: args.to,
              data: args.data ?? '0x',
              value: args.value ? '0x' + args.value.toString(16) : '0x0',
              chain_id: args.chainId,
            },
          },
        }
        const idempotencyKey = `convert-${args.to}-${args.data?.slice(0, 18) ?? ''}-${Date.now()}`
        // The wallet is owned by a key quorum, so the request must carry an authorization
        // signature covering this exact body. Without it Privy refuses with a 401.
        const signed = authorizationHeaders(
          { appId, appSecret, walletId, authorizationKeyId: authorization?.keyId, authorizationPrivateKey: authorization?.privateKey },
          { method: 'POST', path: `/v1/wallets/${walletId}/rpc`, body: payload, idempotencyKey }
        )
        const res = await fetch(`${PRIVY_API}/wallets/${walletId}/rpc`, {
          method: 'POST',
          headers: { ...signed, authorization: auth, 'privy-idempotency-key': idempotencyKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30000),
        })
        const body: any = await res.json().catch(() => null)
        if (!res.ok) {
          lastError = `Privy refused the transaction: ${body?.error ?? res.status}`
          // A missing payment mode is worth trying past; a policy denial or empty wallet is not.
          if (attempts.length > 1 && sponsorUnavailable(lastError)) continue
          throw new Error(lastError)
        }
        const hash = await resolveHash(body)
        if (!hash) throw new Error('Privy returned no transaction hash')
        return hash
      }
      throw new Error(lastError || 'Privy refused the transaction')
    },
  }
}

export function getSigner(input: NodeJS.ProcessEnv = process.env): SignerResult {
  const key = input.AGENT_WALLET_PRIVATE_KEY || ''
  if (key) return { ok: true, signer: localSigner(key) }

  const appId = input.PRIVY_APP_ID || ''
  const appSecret = input.PRIVY_APP_SECRET || ''
  const walletId = input.PRIVY_WALLET_ID || ''
  const address = (input.PLATFORM_AGENT_RECEIVER || '') as `0x${string}`
  if (appId && appSecret && walletId && /^0x[0-9a-fA-F]{40}$/.test(address)) {
    return {
      ok: true,
      signer: privySigner(
        appId,
        appSecret,
        walletId,
        address,
        {
          keyId: input.PRIVY_AUTHORIZATION_KEY_ID,
          privateKey: input.PRIVY_AUTHORIZATION_PRIVATE_KEY,
        },
        (input.PRIVY_SPONSOR_MODE as SponsorMode) || 'off'
      ),
    }
  }

  const missing = [
    !key && 'AGENT_WALLET_PRIVATE_KEY',
    !(appId && appSecret && walletId) && 'PRIVY_APP_ID + PRIVY_APP_SECRET + PRIVY_WALLET_ID',
  ].filter(Boolean).join(' or ')
  return {
    ok: false,
    reason: 'no_signer',
    detail: `No wallet can sign conversions. Set ${missing}. Deposits stay pending until one exists.`,
  }
}
