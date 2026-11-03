import { createPublicClient, http, parseAbi } from 'viem'
import { env } from '../lib/env.js'
import { getTokenPriceUsd } from './oracle.js'
import { getChain, ChainConfig } from './chains.js'

export type VerifyErrorCode =
  | 'not_found'
  | 'failed_tx'
  | 'unsupported_token'
  | 'wrong_recipient'
  | 'wrong_sender'
  | 'zero_amount'
  | 'price_unavailable'
  | 'liquidity_too_low'
  | 'deposit_too_large'

export type VerifyResult =
  | {
      ok: true
      token: string
      amount_usd_micros: number
      /** Raw token units received (string, bigint-safe). */
      raw_amount?: string
      /** Effective USD price used, when the token is oracle-priced. */
      price_usd?: number
      /** Credit haircut applied, in basis points. */
      haircut_bps?: number
    }
  | { ok: false; code: VerifyErrorCode; message: string }

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function parseTopicAddress(topic?: string): string {
  if (!topic) return ''
  const clean = String(topic).toLowerCase().replace(/^0x/, '')
  if (clean.length < 40) return ''
  return '0x' + clean.slice(-40)
}

function parseDataValue(data: any): bigint {
  if (typeof data === 'bigint') return data
  if (typeof data === 'number') return BigInt(data)
  if (typeof data === 'string') {
    const clean = data.trim()
    if (!clean || clean === '0x') return 0n
    return BigInt(clean)
  }
  return 0n
}

export function parseTransferLogs(
  receipt: any,
  chainConfig: ChainConfig,
  receiverAddress: string,
  fromWallet: string
): VerifyResult {
  if (!receipt) {
    return { ok: false, code: 'not_found', message: 'Transaction receipt not found' }
  }

  const statusStr = String(receipt.status ?? '').toLowerCase()
  if (
    receipt.status === false ||
    statusStr === 'reverted' ||
    statusStr === '0' ||
    (statusStr !== 'success' && statusStr !== '1' && statusStr !== 'true')
  ) {
    return { ok: false, code: 'failed_tx', message: 'Transaction status is not success' }
  }

  const logs = receipt.logs
  if (!Array.isArray(logs) || logs.length === 0) {
    return { ok: false, code: 'not_found', message: 'No logs in transaction receipt' }
  }

  const transferLogs: Array<{
    address: string
    from: string
    to: string
    value: bigint
  }> = []

  for (const l of logs) {
    const topic0 = l.topics?.[0]
    if (topic0 && String(topic0).toLowerCase() === TRANSFER_TOPIC) {
      const from = parseTopicAddress(l.topics?.[1])
      const to = parseTopicAddress(l.topics?.[2])
      const address = String(l.address || '').toLowerCase()
      const value = parseDataValue(l.data)
      transferLogs.push({ address, from, to, value })
    }
  }

  if (transferLogs.length === 0) {
    return { ok: false, code: 'not_found', message: 'No ERC-20 Transfer log found in transaction' }
  }

  const receiverLower = (receiverAddress || '').toLowerCase()
  const fromLower = (fromWallet || '').toLowerCase()

  // Look for exact match
  const validLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return tokenConfig && l.to === receiverLower && l.from === fromLower && l.value > 0n
  })

  if (validLog) {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === validLog.address)!
    const rawAmount = validLog.value
    if (tokenConfig.stable === false || tokenConfig.oracle) {
      // Non-stable tokens are valued later in verifyDeposit, which is async.
      return {
        ok: true,
        token: validLog.address,
        amount_usd_micros: 0,
        raw_amount: rawAmount.toString(),
      }
    }
    const amount_usd_micros = Number(
      (rawAmount * 1_000_000n) / (10n ** BigInt(tokenConfig.decimals))
    )
    return {
      ok: true,
      token: validLog.address,
      amount_usd_micros,
      raw_amount: rawAmount.toString(),
    }
  }

  // Reason for non-match
  const zeroLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return tokenConfig && l.to === receiverLower && l.from === fromLower && l.value === 0n
  })
  if (zeroLog) {
    return { ok: false, code: 'zero_amount', message: 'Deposit transfer amount is zero' }
  }

  const wrongSenderLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return tokenConfig && l.to === receiverLower && l.from !== fromLower
  })
  if (wrongSenderLog) {
    return { ok: false, code: 'wrong_sender', message: 'Sender address does not match registered wallet' }
  }

  const wrongRecipientLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return tokenConfig && l.to !== receiverLower
  })
  if (wrongRecipientLog) {
    return { ok: false, code: 'wrong_recipient', message: 'Recipient address does not match platform receiver' }
  }

  const unsupportedTokenLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return !tokenConfig
  })
  if (unsupportedTokenLog) {
    return { ok: false, code: 'unsupported_token', message: 'Token is not supported on this chain' }
  }

  return { ok: false, code: 'not_found', message: 'No matching deposit transfer found in transaction' }
}

export async function verifyDeposit({
  chain,
  txHash,
  fromWallet,
}: {
  chain: string
  txHash: string
  fromWallet: string
}): Promise<VerifyResult> {
  const chainConfig = getChain(chain)
  if (!chainConfig) {
    return { ok: false, code: 'not_found', message: `Chain '${chain}' not found` }
  }

  const hash = (txHash.startsWith('0x') ? txHash : `0x${txHash}`).toLowerCase() as `0x${string}`

  try {
    const client = createPublicClient({
      transport: http(chainConfig.rpc),
    })
    const receipt = await client.getTransactionReceipt({ hash })
    if (!receipt) {
      return { ok: false, code: 'not_found', message: 'Transaction receipt not found' }
    }

    const parsed = parseTransferLogs(receipt, chainConfig, env.platformReceiverAddress, fromWallet)
    if (!parsed.ok) return parsed

    const tokenConfig = chainConfig.tokens.find(
      (t) => t.address.toLowerCase() === parsed.token.toLowerCase()
    )
    if (!tokenConfig?.oracle || !parsed.raw_amount) return parsed

    // Oracle-priced deposit token: quote, guard, then credit with a haircut.
    const quote = await getTokenPriceUsd(tokenConfig)
    if (!quote) {
      return {
        ok: false,
        code: 'price_unavailable',
        message: `No live price for ${tokenConfig.symbol}. This deposit cannot be valued right now.`,
      }
    }
    if (quote.liquidityUsd < tokenConfig.oracle.minLiquidityUsd) {
      return {
        ok: false,
        code: 'liquidity_too_low',
        message: `${tokenConfig.symbol} market liquidity ($${Math.round(
          quote.liquidityUsd
        )}) is below the $${tokenConfig.oracle.minLiquidityUsd} floor.`,
      }
    }

    const rawAmount = BigInt(parsed.raw_amount)
    const tokenAmount = Number(rawAmount) / 10 ** tokenConfig.decimals
    const haircut = 1 - tokenConfig.oracle.haircutBps / 10_000
    const grossUsd = tokenAmount * quote.priceUsd
    const netUsd = grossUsd * haircut

    if (netUsd > tokenConfig.oracle.maxDepositUsd) {
      return {
        ok: false,
        code: 'deposit_too_large',
        message: `Deposit is worth about $${netUsd.toFixed(
          2
        )}, above the $${tokenConfig.oracle.maxDepositUsd} cap for ${tokenConfig.symbol}. Send a smaller amount.`,
      }
    }
    if (netUsd < 0.01) {
      return {
        ok: false,
        code: 'zero_amount',
        message: 'Deposit value is below $0.01 after conversion.',
      }
    }

    return {
      ok: true,
      token: parsed.token,
      amount_usd_micros: Math.floor(netUsd * 1_000_000),
      raw_amount: parsed.raw_amount,
      price_usd: quote.priceUsd,
      haircut_bps: tokenConfig.oracle.haircutBps,
    }
  } catch (err: any) {
    return {
      ok: false,
      code: 'not_found',
      message: err?.message || 'Transaction receipt not found',
    }
  }
}

/**
 * Find any ERC-20 transfer into one of our receiving wallets, whatever the
 * token is. Registration is not required: an unregistered token is valued by
 * the market analysis before it can be credited, so we do not need a hardcoded
 * list to accept a payment.
 */
export type IncomingTransfer = {
  chain_id: number
  token: string
  from: string
  to: string
  raw_amount: string
  decimals: number
  registered: boolean
  block_number: number
}

export async function findIncomingTransfer(params: {
  chainId: number
  txHash: string
  receivers: string[]
}): Promise<{ ok: true; transfer: IncomingTransfer } | { ok: false; code: string; message: string }> {
  const chainConfig = getChain(String(params.chainId))
  if (!chainConfig) {
    return { ok: false, code: 'unsupported_chain', message: `Chain ${params.chainId} is not configured` }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) {
    return { ok: false, code: 'not_found', message: 'tx_hash must be a 32-byte hex hash' }
  }
  const receivers = params.receivers.map((r) => String(r || '').toLowerCase()).filter((r) => /^0x[0-9a-f]{40}$/.test(r))
  if (receivers.length === 0) {
    return { ok: false, code: 'wrong_recipient', message: 'No platform receiving wallet is configured' }
  }

  const client = createPublicClient({ transport: http(chainConfig.rpc) })
  let receipt: any
  try {
    receipt = await client.request({ method: 'eth_getTransactionReceipt', params: [params.txHash as `0x${string}`] } as any)
  } catch (err: any) {
    return { ok: false, code: 'not_found', message: `Could not read receipt: ${err?.shortMessage || err?.message || 'rpc error'}` }
  }
  if (!receipt) return { ok: false, code: 'not_found', message: 'Transaction not found on this chain' }
  if (!(receipt.status === '0x1' || receipt.status === 1 || receipt.status === true)) {
    return { ok: false, code: 'failed_tx', message: 'Transaction did not succeed' }
  }

  const candidates: Array<{ token: string; from: string; to: string; value: bigint }> = []
  for (const l of receipt.logs || []) {
    if (String(l.topics?.[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue
    if ((l.topics || []).length < 3) continue // ERC-721 style; not a fungible deposit
    const to = parseTopicAddress(l.topics[2])
    if (!receivers.includes(to)) continue
    const value = parseDataValue(l.data)
    if (value <= 0n) continue
    candidates.push({ token: String(l.address || '').toLowerCase(), from: parseTopicAddress(l.topics[1]), to, value })
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'wrong_recipient',
      message: `No ERC-20 transfer to a platform wallet in this transaction (looked for ${receivers.length} receiver${receivers.length === 1 ? '' : 's'})`,
    }
  }

  // Largest transfer wins: dust transfers are a common distraction in a tx.
  candidates.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
  const pick = candidates[0]
  const registeredToken = chainConfig.tokens.find((t) => t.address.toLowerCase() === pick.token)

  let decimals = registeredToken?.decimals
  if (decimals === undefined) {
    try {
      const dec = await client.readContract({
        address: pick.token as `0x${string}`,
        abi: parseAbi(['function decimals() view returns (uint8)']),
        functionName: 'decimals',
      })
      decimals = Number(dec)
    } catch {
      return { ok: false, code: 'unsupported_token', message: 'Token does not implement decimals(); refusing to guess its scale' }
    }
  }
  if (!Number.isFinite(decimals) || decimals > 36) {
    return { ok: false, code: 'unsupported_token', message: `Implausible token decimals (${decimals})` }
  }

  return {
    ok: true,
    transfer: {
      chain_id: params.chainId,
      token: pick.token,
      from: pick.from,
      to: pick.to,
      raw_amount: pick.value.toString(),
      decimals,
      registered: Boolean(registeredToken),
      block_number: Number(receipt.blockNumber ?? 0),
    },
  }
}
