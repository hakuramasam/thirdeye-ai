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

function privySigner(
  appId: string,
  appSecret: string,
  walletId: string,
  address: `0x${string}`,
  authorization?: { keyId?: string; privateKey?: string }
): Signer {
  const auth = 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64')
  return {
    kind: 'privy',
    address,
    async sendTransaction(args) {
      // Privy signs eth_sendTransaction for a server wallet; the key never reaches us.
      const payload = {
        method: 'eth_sendTransaction',
        caip2: `eip155:${args.chainId}`,
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
      if (!res.ok) throw new Error(`Privy refused the transaction: ${body?.error ?? res.status}`)
      const hash = body?.data?.hash ?? body?.data?.transaction_hash ?? body?.hash
      if (!hash) throw new Error('Privy returned no transaction hash')
      return hash as `0x${string}`
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
      signer: privySigner(appId, appSecret, walletId, address, {
        keyId: input.PRIVY_AUTHORIZATION_KEY_ID,
        privateKey: input.PRIVY_AUTHORIZATION_PRIVATE_KEY,
      }),
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
