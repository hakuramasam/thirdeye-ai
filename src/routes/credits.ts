import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { env } from '../lib/env.js'
import { query } from '../db/index.js'
import { getBalanceMicros, creditDeposit } from '../lib/billing.js'
import { CHAINS } from '../payments/chains.js'
import { verifyDeposit } from '../payments/verify.js'
import { findIncomingTransfer } from '../payments/verify.js'
import { prepareAutoConvert, autoConvertPolicyFromEnv } from '../payments/autoConvert.js'

export function registerCreditsRoutes(app: SessionApp): void {
  // GET /api/credits
  app.get('/api/credits', requireUser, async (c) => {
    const user = c.get('user')!
    const balance_usd_micros = await getBalanceMicros(user.id)
    const ledgerResult = await query(
      `SELECT amount_usd_micros, kind, ref, created_at
       FROM ledger
       WHERE user_id = $1
       ORDER BY id DESC
       LIMIT 50`,
      [user.id]
    )
    const ledger = ledgerResult.rows.map((r) => ({
      amount_usd_micros: Number(r.amount_usd_micros),
      kind: r.kind,
      ref: r.ref,
      created_at: r.created_at,
    }))

    return c.json({
      balance_usd_micros,
      ledger,
    })
  })

  // GET /api/credits/deposit-info
  app.get('/api/credits/deposit-info', requireUser, async (c) => {
    const receiver_address = env.platformReceiverAddress || ''
    const configured = Boolean(receiver_address)
    const agent_receiver = env.platformAgentReceiver || ''
    return c.json({
      receiver_address,
      agent_receiver,
      configured: Boolean(receiver_address || agent_receiver),
      receivers: [receiver_address, agent_receiver].filter(Boolean),
      chains: CHAINS,
    })
  })

  // POST /api/credits/payment-review - verify an ERC-20 payment landed in one of
  // our wallets and value it in USD. Read-only: credits nothing. Works for any
  // token, registered or not, on Base, BSC and Robinhood Chain.
  app.post('/api/credits/payment-review', requireUser, async (c) => {
    let body: any
    try { body = await c.req.json() } catch { body = {} }
    const chainId = Number(body?.chain_id ?? body?.chainId ?? 0)
    const txHash = String(body?.tx_hash ?? body?.txHash ?? '')
    if (!chainId || !txHash) {
      return c.json({ error: { message: 'chain_id and tx_hash are required', type: 'validation' } }, 400)
    }
    const receivers = [env.platformReceiverAddress, env.platformAgentReceiver].filter(Boolean) as string[]
    const found = await findIncomingTransfer({ chainId, txHash, receivers })
    if (!found.ok) {
      return c.json({ accepted: false, verification: { ok: false, code: found.code, message: found.message } }, 422)
    }
    const t = found.transfer
    const prepared = await prepareAutoConvert({
      chainId,
      tokenAddress: t.token,
      amountRaw: BigInt(t.raw_amount),
      decimals: t.decimals,
    })
    const atVault = t.to === String(env.platformReceiverAddress || '').toLowerCase()
    const received_at = atVault ? 'treasury_vault' : 'agent_wallet'
    if (!prepared.ok) {
      return c.json(
        { accepted: false, received_at, verification: { ok: true, ...t }, refusal: { code: prepared.code, message: prepared.message } },
        422
      )
    }
    return c.json({
      accepted: true,
      received_at,
      verification: { ok: true, ...t },
      value_usd: prepared.analysis.amountUsd,
      price_usd: prepared.analysis.priceUsd,
      liquidity_usd: prepared.analysis.liquidityUsd,
      volume_24h_usd: prepared.analysis.volume24hUsd,
      impact_bps: prepared.analysis.impactBps,
      pool: prepared.analysis.poolAddress,
      settlement_token: prepared.settlementToken,
      note: prepared.note,
    })
  })

  // POST /api/credits/auto-convert — analyse a token deposit and price the conversion
  // Body: { chain, token, amount_raw, decimals } | { chain, token, amount }
  // Read-only: it never moves funds or writes credits, so it is safe to call from
  // the deposit page before the user sends anything.
  app.post('/api/credits/auto-convert/check', requireUser, async (c) => {
    const body: any = await c.req.json().catch(() => ({}))
    const chainId = Number(body?.chain_id ?? body?.chainId ?? body?.chain)
    const token = String(body?.token ?? body?.token_address ?? '')
    const decimals = Number(body?.decimals ?? 18)
    if (!Number.isInteger(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(token) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      return c.json({ error: { message: 'chain_id, token (0x…) and decimals are required', type: 'invalid_request', code: 400 } }, 400)
    }
    let amountRaw: bigint
    try {
      amountRaw = body?.amount_raw ? BigInt(String(body.amount_raw)) : BigInt(Math.round(Number(body?.amount ?? 0) * 10 ** decimals))
    } catch {
      return c.json({ error: { message: 'amount could not be parsed', type: 'invalid_request', code: 400 } }, 400)
    }
    if (amountRaw <= 0n) {
      return c.json({ error: { message: 'amount must be greater than zero', type: 'invalid_request', code: 400 } }, 400)
    }
    const policy = autoConvertPolicyFromEnv()
    const result = await prepareAutoConvert({ chainId, tokenAddress: token, amountRaw, decimals, policy })
    const flat = result.ok
      ? {
          ...result.analysis,
          tradable: true,
          settlement_token: result.settlementToken,
          note: result.note,
        }
      : { tradable: false, code: result.code, message: result.message }
    return c.json({
      auto_convert_enabled: policy.enabled,
      policy: {
        min_liquidity_usd: policy.minLiquidityUsd,
        min_volume_24h_usd: policy.minVolume24hUsd,
        max_impact_bps: policy.maxPriceImpactBps,
        max_auto_convert_usd: policy.maxAutoConvertUsd,
        slippage_bps: policy.slippageBps,
      },
      result: flat,
    }, result.ok ? 200 : 422)
  })

  // POST /api/credits/deposit
  app.post('/api/credits/deposit', requireUser, async (c) => {
    const receiver_address = env.platformReceiverAddress || ''
    if (!receiver_address) {
      return c.json(
        {
          error: {
            message: 'Platform receiver wallet not configured',
            type: 'billing',
          },
        },
        503
      )
    }

    const user = c.get('user')!
    let body: any
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }

    const chain = body?.chain
    const tx_hash = body?.tx_hash || body?.txHash

    if (!chain || !tx_hash) {
      return c.json(
        {
          error: {
            message: 'Missing required fields: chain, tx_hash',
            type: 'billing',
            code: 'invalid_request',
          },
        },
        400
      )
    }

    const verification = await verifyDeposit({
      chain,
      txHash: tx_hash,
      fromWallet: user.wallet,
    })

    if (!verification.ok) {
      const status = verification.code === 'not_found' ? 404 : 400
      return c.json(
        {
          error: {
            message: verification.message,
            type: 'billing',
            code: verification.code,
          },
        },
        status
      )
    }

    const depositResult = await creditDeposit(user.id, verification.amount_usd_micros, {
      chain,
      txHash: tx_hash,
      token: verification.token,
    })

    return c.json({
      credited: depositResult.credited,
      balance_usd_micros: depositResult.balance,
    })
  })
}
