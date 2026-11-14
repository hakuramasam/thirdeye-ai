import { createPublicClient, http, parseAbi } from 'viem'
import { env, platformReceivers } from '../lib/env.js'
import { getTokenPriceUsd } from './oracle.js'
import { getChain, CHAINS, ChainConfig } from './chains.js'
import { finalityVerdict, FinalityVerdict } from './finality.js'
import { rawAmountToNumber } from '../lib/money.js'

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
  | 'insufficient_confirmations'
  | 'rpc_error'

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
      /** Credit premium applied, in basis points (platform token perk). */
      bonus_bps?: number
      /** Value of the tokens before the bonus, in USD. */
      base_usd?: number
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
  receiverAddress: string | string[],
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

  // A deposit is ours whichever of our receiving wallets it lands in, so the caller may pass
  // one address or the whole set. Empty entries are dropped rather than matched.
  const receivers = new Set(
    (Array.isArray(receiverAddress) ? receiverAddress : [receiverAddress])
      .map((a) => String(a || '').toLowerCase())
      .filter(Boolean)
  )
  const fromLower = (fromWallet || '').toLowerCase()

  // Look for exact match
  const validLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return tokenConfig && receivers.has(l.to) && l.from === fromLower && l.value > 0n
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
    return tokenConfig && receivers.has(l.to) && l.from === fromLower && l.value === 0n
  })
  if (zeroLog) {
    return { ok: false, code: 'zero_amount', message: 'Deposit transfer amount is zero' }
  }

  const wrongSenderLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return tokenConfig && receivers.has(l.to) && l.from !== fromLower
  })
  if (wrongSenderLog) {
    return { ok: false, code: 'wrong_sender', message: 'Sender address does not match registered wallet' }
  }

  const wrongRecipientLog = transferLogs.find((l) => {
    const tokenConfig = chainConfig.tokens.find((t) => t.address.toLowerCase() === l.address)
    return tokenConfig && !receivers.has(l.to)
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

    const parsed = parseTransferLogs(receipt, chainConfig, platformReceivers(), fromWallet)
    if (!parsed.ok) return parsed

    // Finality gate. A receipt at one confirmation can still be replaced by a reorg, so the
    // transfer is neither valued nor credited until block depth meets the chain's policy.
    // An unreadable head is a wait, not a missing transaction: reporting it as `not_found` told
    // the caller a real deposit did not exist. It matches findIncomingTransfer, which counts an
    // unreadable head as zero confirmations.
    let headBlock: bigint | null = null
    try {
      headBlock = await client.getBlockNumber()
    } catch {
      headBlock = null
    }
    const verdict = finalityVerdict({
      chainId: chainConfig.chainId,
      receiptBlock: receipt.blockNumber ?? null,
      headBlock: headBlock ?? 0n,
    })
    if (verdict.state !== 'confirmed') {
      return {
        ok: false,
        code: 'insufficient_confirmations',
        message: verdict.unverifiable === 'unreadable_head' || headBlock === null
          ? `The current block height on chain ${chainConfig.chainId} could not be read, so this transfer cannot be shown to be final yet. Nothing is credited; retry shortly.`
          : `This transfer has ${verdict.confirmations} of ${verdict.required} required confirmations on ${chainConfig.chainId}. Nothing is credited until it is buried that deep; retry this claim then.`,
      }
    }

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
    const floor = Number(tokenConfig.oracle.minLiquidityUsd ?? 0)
    if (!quote.policy && quote.liquidityUsd < floor) {
      return {
        ok: false,
        code: 'liquidity_too_low',
        message: `${tokenConfig.symbol} market liquidity ($${Math.round(
          quote.liquidityUsd
        )}) is below the $${floor} floor.`,
      }
    }

    const rawAmount = BigInt(parsed.raw_amount)
    // Exact first, dollar-scale float second: Number(raw) loses precision on 18-decimal values.
    const tokenAmount = rawAmountToNumber(rawAmount, tokenConfig.decimals)
    const haircut = 1 - tokenConfig.oracle.haircutBps / 10_000
    const bonusBps = Number(tokenConfig.oracle.bonusBps ?? 0)
    const grossUsd = tokenAmount * quote.priceUsd
    const netUsd = grossUsd * haircut

    // The cap is applied to the valued amount, never to the bonus, so the perk cannot be
    // used to walk past the per-deposit limit.
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

    const creditedUsd = netUsd * (1 + bonusBps / 10_000)
    return {
      ok: true,
      token: parsed.token,
      amount_usd_micros: Math.floor(creditedUsd * 1_000_000),
      raw_amount: parsed.raw_amount,
      price_usd: quote.priceUsd,
      haircut_bps: tokenConfig.oracle.haircutBps,
      bonus_bps: bonusBps,
      base_usd: netUsd,
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
  tx_hash: string
  token: string
  from: string
  to: string
  raw_amount: string
  decimals: number
  registered: boolean
  block_number: number
  /** Block depth observed at claim time, and the depth this chain requires. */
  confirmations: number
  required_confirmations: number
}

export async function findIncomingTransfer(params: {
  chainId: number
  txHash: string
  receivers: string[]
}): Promise<
  | { ok: true; transfer: IncomingTransfer; finality: FinalityVerdict }
  | { ok: false; code: string; message: string }
> {
  const chainConfig = getChain(String(params.chainId)) ?? CHAINS.find((c) => c.chainId === params.chainId)
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
    // A failed read is not an absent transaction. Reporting an RPC outage as `not_found` let one
    // flaky call mark a real deposit reorged, and the row then refused to credit forever.
    return { ok: false, code: 'rpc_error', message: `Could not read receipt: ${err?.shortMessage || err?.message || 'rpc error'}` }
  }
  if (!receipt) return { ok: false, code: 'not_found', message: 'Transaction not found on this chain' }
  if (!(receipt.status === '0x1' || receipt.status === 1 || receipt.status === true)) {
    return { ok: false, code: 'failed_tx', message: 'Transaction did not succeed' }
  }

  // Depth is measured here, before anything is valued or recorded, so the caller can store a
  // confirming payment instead of crediting it. An unreadable head block counts as zero
  // confirmations on purpose: waiting is safe, crediting on a guess is not.
  let headBlock = 0n
  try {
    headBlock = BigInt(String(await client.request({ method: 'eth_blockNumber', params: [] } as any)))
  } catch {
    headBlock = 0n
  }
  const finality = finalityVerdict({
    chainId: params.chainId,
    receiptBlock: receipt.blockNumber ?? null,
    headBlock,
  })

  // Native sends are recorded against the zero address, the same sentinel Uniswap v4 and the
  // market analyser use for the native coin.
  const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000'
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
  // A native send (ETH, BNB) emits no Transfer log, so it has to be read from the transaction
  // itself. Without this a native deposit looked like "wrong recipient" and could never be claimed.
  if (candidates.length === 0) {
    try {
      const tx: any = await client.request({ method: 'eth_getTransactionByHash', params: [params.txHash as `0x${string}`] } as any)
      const to = String(tx?.to || '').toLowerCase()
      const value = tx?.value ? BigInt(tx.value) : 0n
      if (tx && to && receivers.includes(to) && value > 0n) {
        candidates.push({ token: NATIVE_SENTINEL, from: String(tx.from || '').toLowerCase(), to, value })
      }
    } catch {
      // Fall through to the refusal below; an unreadable tx is not a deposit.
    }
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'wrong_recipient',
      message: `No ERC-20 or native transfer to a platform wallet in this transaction (looked for ${receivers.length} receiver${receivers.length === 1 ? '' : 's'})`,
    }
  }

  // Largest transfer wins: dust transfers are a common distraction in a tx.
  candidates.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
  const pick = candidates[0]
  const registeredToken = chainConfig.tokens.find((t) => t.address.toLowerCase() === pick.token)

  // ETH and BNB are both 18 decimals and have no contract to ask.
  let decimals = registeredToken?.decimals ?? (pick.token === NATIVE_SENTINEL ? 18 : undefined)
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
      tx_hash: params.txHash.toLowerCase(),
      token: pick.token,
      from: pick.from,
      to: pick.to,
      raw_amount: pick.value.toString(),
      decimals,
      registered: Boolean(registeredToken),
      block_number: Number(receipt.blockNumber ?? 0),
      confirmations: finality.confirmations,
      required_confirmations: finality.required,
    },
    finality,
  }
}

/**
 * Does the wallet that actually sent the transfer belong to the authenticated caller?
 *
 * /api/credits/deposit has always passed the session wallet into verifyDeposit, but the newer
 * /api/credits/payment-review values the transfer, records a payment row and can release
 * spendable credit without ever comparing the sender to the caller. Because recording is
 * first-claim-wins, an observer of any inbound transfer to our receivers could claim it as
 * their own before the real sender did. This is a pure function so the rule can be tested
 * without a chain or a database.
 */
export type SenderOwnershipVerdict =
  | { ok: true; sender: string }
  | { ok: false; code: 'sender_not_owner' | 'sender_missing'; message: string }

export function checkSenderOwnership(input: { sender?: string | null; sessionWallet?: string | null }): SenderOwnershipVerdict {
  const sender = String(input.sender ?? '').trim().toLowerCase()
  const wallet = String(input.sessionWallet ?? '').trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(sender)) {
    return { ok: false, code: 'sender_missing', message: 'The transfer has no readable sender address, so ownership cannot be established.' }
  }
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    return { ok: false, code: 'sender_not_owner', message: 'This account has no registered wallet, so a transfer cannot be attributed to it.' }
  }
  if (sender !== wallet) {
    return {
      ok: false,
      code: 'sender_not_owner',
      message: 'The sender of this transfer is not the wallet signed in to this account, so it cannot be claimed here.',
    }
  }
  return { ok: true, sender }
}
