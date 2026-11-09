/**
 * Conversion executor for pending volatile-token deposits.
 *
 * A deposit of a non-settlement token is recorded with status pending_conversion and no credit.
 * This module does the part that turns it into money: quote, approve if needed, swap to the
 * settlement stablecoin from a wallet we can sign for, wait for the receipt, measure what the
 * swap actually produced, then settle so the user is credited that amount.
 *
 * Ordering rule: credit is always computed from the measured stablecoin delta, never from the
 * quote. The token row is claimed before the swap and released only after the outcome is known,
 * so two concurrent passes cannot swap the same deposit twice.
 */
import { one, query } from '../db/index.js'
import { CHAINS } from './chains.js'
import { executeNativeSwap, isNativeAsset, nativeRail, privyEnvFromEnv, readErc20Balance, toMicros } from './nativeSwap.js'
import { USDC_BASE } from './swap.js'
import { prepareBaseSwapOnchain, liveV3Reader } from './v3swap.js'
import { getSigner, type Signer } from './signer.js'
import { settleConversion } from '../lib/settle.js'

const ERC20 = {
  balanceOf: '0x70a08231', // balanceOf(address)
  allowance: '0xdd62ed3e', // allowance(address,address)
  approve: '0x095ea7b3', // approve(address,uint256)
}

export type ConversionOutcome =
  | { paymentId: string; status: 'credited'; swapTx: string; creditedMicros: number; measuredUsdMicros: number }
  | { paymentId: string; status: 'blocked'; reason: string; detail: string }
  | { paymentId: string; status: 'failed'; reason: string; detail: string }
  | { paymentId: string; status: 'skipped'; reason: string }

export type ConvertDeps = {
  signer?: Signer | null
  signerBlock?: { reason: string; detail: string } | null
  readBalance?: (token: string, owner: string) => Promise<bigint>
  readAllowance?: (token: string, owner: string, spender: string) => Promise<bigint>
  prepare?: typeof defaultPrepare
  approve?: (args: { token: string; spender: string; amount: bigint; signer: Signer }) => Promise<`0x${string}`>
  waitForReceipt?: (hash: string) => Promise<{ ok: boolean; gasUsed?: bigint }>
  settle?: typeof settleConversion
  now?: () => number
}

async function rpc(method: string, params: any[]): Promise<any> {
  const res = await fetch(process.env.BASE_RPC_URL || 'https://mainnet.base.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  })
  const body: any = await res.json().catch(() => null)
  if (body?.error) throw new Error(body.error.message ?? 'rpc error')
  return body?.result
}

const encAddress = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const encUint = (v: bigint) => v.toString(16).padStart(64, '0')

async function defaultReadBalance(token: string, owner: string): Promise<bigint> {
  const r = await rpc('eth_call', [{ to: token, data: ERC20.balanceOf + encAddress(owner) }, 'latest'])
  return BigInt(r ?? '0x0')
}
async function defaultReadAllowance(token: string, owner: string, spender: string): Promise<bigint> {
  const r = await rpc('eth_call', [{ to: token, data: ERC20.allowance + encAddress(owner) + encAddress(spender) }, 'latest'])
  return BigInt(r ?? '0x0')
}

async function defaultWaitForReceipt(hash: string): Promise<{ ok: boolean }> {
  for (let i = 0; i < 30; i++) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null)
    if (receipt) return { ok: receipt.status === '0x1' }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { ok: false }
}

/** Claim a pending row so only one executor works it. */
async function claim(paymentId: string): Promise<boolean> {
  const row = await one(
    `UPDATE payments SET status = 'converting'
      WHERE id = $1 AND status = 'pending_conversion' RETURNING id`,
    [paymentId]
  )
  await query(
    `INSERT INTO payment_conversion_audit (payment_id, event, detail) VALUES ($1, 'claimed', 'executor took the deposit')`,
    [paymentId]
  ).catch(() => {})
  return Boolean(row)
}

async function release(paymentId: string, reason: string): Promise<void> {
  await query(
    `UPDATE payments SET status = 'pending_conversion' WHERE id = $1 AND status = 'converting'`,
    [paymentId]
  )
  await query(
    `INSERT INTO payment_conversion_audit (payment_id, event, detail) VALUES ($1, 'released', $2)`,
    [paymentId, reason.slice(0, 300)]
  ).catch(() => {})
}

/**
 * Quotes and assembles the swap straight from chain state, so a conversion never waits on a
 * vendor key. The prepare dependency stays injectable so tests can pin the route.
 */
type PrepareParams = { tokenIn: string; amountIn: bigint; swapper: string; slippageBps: number; tokenOut?: string }
const defaultPrepare = (params: PrepareParams) =>
  prepareBaseSwapOnchain({
    tokenIn: params.tokenIn as `0x${string}`,
    amountIn: params.amountIn,
    swapper: params.swapper as `0x${string}`,
    slippageBps: params.slippageBps,
    tokenOut: params.tokenOut as `0x${string}` | undefined,
    reader: liveV3Reader(),
  })

export async function convertOne(paymentId: string, deps: ConvertDeps = {}): Promise<ConversionOutcome> {
  const signerRes = deps.signer !== undefined
    ? (deps.signer ? { ok: true as const, signer: deps.signer } : { ok: false as const, ...(deps.signerBlock ?? { reason: 'no_signer', detail: 'No signer available' }) })
    : getSigner()
  const settle = deps.settle ?? settleConversion
  const readBalance = deps.readBalance ?? defaultReadBalance
  const readAllowance = deps.readAllowance ?? defaultReadAllowance
  const prepare = deps.prepare ?? defaultPrepare
  const waitForReceipt = deps.waitForReceipt ?? defaultWaitForReceipt

  const payment = await one('SELECT * FROM payments WHERE id = $1', [paymentId])
  if (!payment) return { paymentId, status: 'failed', reason: 'not_found', detail: 'Payment not found' }
  const p = payment as any

  const settled = await query(`SELECT status FROM payments WHERE id = $1`, [paymentId])
  if ((settled.rows[0] as any)?.status !== 'pending_conversion') {
    return { paymentId, status: 'skipped', reason: `status is ${(settled.rows[0] as any)?.status}` }
  }

  // Resolve by chain id first: the payments table stores chain_id, and there is no chain_slug column,
  // so reading the slug first silently treated every non-Base deposit as Base.
  const chain = CHAINS.find((c: any) => c.chainId === Number(p.chain_id)) ?? CHAINS.find((c: any) => c.id === (p.chain_slug || 'base'))
  const chainSlug = chain?.id ?? 'base'
  if (!chain) return { paymentId, status: 'blocked', reason: 'unsupported_chain', detail: `No chain config for ${p.chain_id}` }
  // Native assets go through the Privy swap engine, which covers Base and BSC. ERC-20 conversions
  // still run through our own v3 router on Base only.
  const nativeAsset = isNativeAsset(chain.chainId, String(p.token ?? ''))
  if (chainSlug !== 'base' && !nativeAsset) {
    return { paymentId, status: 'blocked', reason: 'chain_not_implemented', detail: 'The ERC-20 executor converts on Base only today' }
  }

  if (!signerRes.ok) {
    return { paymentId, status: 'blocked', reason: (signerRes as any).reason ?? 'no_signer', detail: (signerRes as any).detail ?? '' }
  }
  const signer = (signerRes as any).signer as Signer

  // The token must already be in the wallet we can sign for; the treasury vault is passkey-only.
  const receivedBy: string = String(p.received_by ?? '')
  if (receivedBy && p.token && receivedBy.toLowerCase() !== signer.address.toLowerCase()) {
    const isAgentWallet = receivedBy.toLowerCase() === String(process.env.PLATFORM_AGENT_RECEIVER ?? '').toLowerCase()
    if (!isAgentWallet) {
      return {
        paymentId,
        status: 'blocked',
        reason: 'not_in_signing_wallet',
        detail: `The deposit sits in ${receivedBy}, which this server cannot sign for. It must land in ${signer.address} to be converted.`,
      }
    }
  }

  if (!(await claim(paymentId))) return { paymentId, status: 'skipped', reason: 'claimed_by_another_run' }

  try {
    const token = String(p.token)
    const amountRaw = BigInt(String(p.raw_amount ?? '0'))
    if (amountRaw <= 0n) {
      await release(paymentId, 'zero amount')
      return { paymentId, status: 'failed', reason: 'zero_amount', detail: 'Nothing to convert' }
    }

    // Native ETH/BNB: no token contract, no approval, and Privy submits the swap itself.
    if (nativeAsset) {
      const rail = nativeRail(chain.chainId)!
      const privyAuth = privyEnvFromEnv()
      if (!privyAuth) {
        await release(paymentId, 'privy not configured for native conversions')
        return { paymentId, status: 'blocked', reason: 'privy_not_configured', detail: 'Privy credentials are not set for this deployment' }
      }
      const beforeNative = await readErc20Balance(chain.chainId, rail.settlement.address, signer.address)
      const run = await executeNativeSwap({ chainId: chain.chainId, amountRaw, auth: privyAuth })
      if (!run.ok) {
        await release(paymentId, run.message)
        return { paymentId, status: 'blocked', reason: run.code, detail: run.message }
      }
      const afterNative = await readErc20Balance(chain.chainId, rail.settlement.address, signer.address)
      const gained = beforeNative !== null && afterNative !== null && afterNative > beforeNative ? afterNative - beforeNative : 0n
      if (gained <= 0n) {
        await release(paymentId, 'native swap produced no stablecoin')
        return {
          paymentId,
          status: 'failed',
          reason: 'no_stablecoin_received',
          detail: `Native swap ${run.actionId} settled but no ${rail.settlement.symbol} was measured in the wallet`,
        }
      }
      const realisedUsdMicros = toMicros(gained, rail.settlement.decimals)
      if (realisedUsdMicros <= 0) {
        await release(paymentId, 'measured stablecoin rounded to zero')
        return { paymentId, status: 'failed', reason: 'no_stablecoin_received', detail: 'Measured amount rounded to zero micros' }
      }
      const settledNative = await settle(paymentId, { realisedUsdMicros, swapTx: run.txHash ?? run.actionId })
      if (!settledNative.ok) {
        await release(paymentId, `settle refused: ${settledNative.detail}`)
        return { paymentId, status: 'failed', reason: `settle_${settledNative.problem}`, detail: settledNative.detail }
      }
      return {
        paymentId,
        status: 'credited',
        swapTx: run.txHash ?? run.actionId,
        creditedMicros: settledNative.creditedMicros,
        measuredUsdMicros: realisedUsdMicros,
      }
    }

    const before = await readBalance(USDC_BASE, signer.address)

    const prepared = await prepare({ tokenIn: token, amountIn: amountRaw, swapper: signer.address, slippageBps: 150 })
    if (!prepared.ok) {
      await release(paymentId, `prepare refused: ${prepared.message}`)
      return { paymentId, status: 'blocked', reason: prepared.code, detail: prepared.message }
    }

    // Approve only when Uniswap says the router is not already allowed to pull the token.
    if (prepared.approval) {
      const approveTx = await signer.sendTransaction({
        to: prepared.approval.to as `0x${string}`,
        data: prepared.approval.data as `0x${string}`,
        value: BigInt(prepared.approval.value || '0'),
        chainId: 8453,
      })
      const approved = await waitForReceipt(approveTx)
      if (!approved.ok) {
        await release(paymentId, `approval failed ${approveTx}`)
        return { paymentId, status: 'failed', reason: 'approval_failed', detail: `Approval tx ${approveTx} did not succeed` }
      }
    }

    // The real swap payload from Uniswap, signed by the wallet that holds the token.
    const swapTx = await signer.sendTransaction({
      to: prepared.swap.to as `0x${string}`,
      data: prepared.swap.data as `0x${string}`,
      value: BigInt(prepared.swap.value || '0'),
      chainId: 8453,
    })
    const receipt = await waitForReceipt(swapTx)
    if (!receipt.ok) {
      await release(paymentId, `swap failed ${swapTx}`)
      return { paymentId, status: 'failed', reason: 'swap_failed', detail: `Swap tx ${swapTx} did not succeed` }
    }

    const after = await readBalance(USDC_BASE, signer.address)
    const gained = after > before ? after - before : 0n
    // USDC on Base has 6 decimals, so the delta in micros is the delta in dollars.
    const measuredUsdMicros = Number(gained)
    if (measuredUsdMicros <= 0) {
      await release(paymentId, 'swap produced no stablecoin')
      return { paymentId, status: 'failed', reason: 'no_stablecoin_received', detail: 'The swap settled but no USDC arrived; not crediting anything.' }
    }

    const settledResult = await settle(paymentId, { realisedUsdMicros: measuredUsdMicros, swapTx })
    if (!settledResult.ok) {
      await release(paymentId, `settle refused: ${settledResult.detail}`)
      return { paymentId, status: 'failed', reason: `settle_${settledResult.problem}`, detail: settledResult.detail }
    }
    return { paymentId, status: 'credited', swapTx, creditedMicros: settledResult.creditedMicros, measuredUsdMicros }
  } catch (e: any) {
    await release(paymentId, String(e?.message ?? e))
    return { paymentId, status: 'failed', reason: 'executor_error', detail: String(e?.message ?? e).slice(0, 300) }
  }
}

/** Run one pass over pending deposits. Bounded so a single invocation cannot run away. */
export async function convertPending(input: { limit?: number; deps?: ConvertDeps } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20)
  const res = await query(
    `SELECT id FROM payments WHERE status = 'pending_conversion' ORDER BY created_at ASC LIMIT $1`,
    [limit]
  )
  const outcomes: ConversionOutcome[] = []
  for (const row of res.rows as any[]) {
    outcomes.push(await convertOne(row.id, input.deps ?? {}))
  }
  return {
    examined: outcomes.length,
    credited: outcomes.filter((o) => o.status === 'credited').length,
    blocked: outcomes.filter((o) => o.status === 'blocked').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    outcomes,
  }
}
