import { createPublicClient, http } from 'viem'
import { env } from '../lib/env.js'
import { getChain, ChainConfig } from './chains.js'

export type VerifyErrorCode =
  | 'not_found'
  | 'failed_tx'
  | 'unsupported_token'
  | 'wrong_recipient'
  | 'wrong_sender'
  | 'zero_amount'

export type VerifyResult =
  | { ok: true; token: string; amount_usd_micros: number }
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
    const amount_usd_micros = Number(
      (validLog.value * 1_000_000n) / (10n ** BigInt(tokenConfig.decimals))
    )
    return {
      ok: true,
      token: validLog.address,
      amount_usd_micros,
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

    return parseTransferLogs(receipt, chainConfig, env.platformReceiverAddress, fromWallet)
  } catch (err: any) {
    return {
      ok: false,
      code: 'not_found',
      message: err?.message || 'Transaction receipt not found',
    }
  }
}
