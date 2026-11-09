import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { env } from '../lib/env.js'
import { query } from '../db/index.js'
import { getBalanceMicros, creditDeposit } from '../lib/billing.js'
import { one } from '../db/index.js'
import { creditKey } from '../lib/keycredit.js'
import { decideCredit } from '../lib/creditPolicy.js'
import { CHAINS } from '../payments/chains.js'
import { verifyDeposit } from '../payments/verify.js'
import { findIncomingTransfer, checkSenderOwnership } from '../payments/verify.js'
import { prepareAutoConvert, autoConvertPolicyFromEnv } from '../payments/autoConvert.js'
import { randomBytes } from 'node:crypto'
import type { IncomingTransfer } from '../payments/verify.js'

/** Chain slug used by the deposits/ledger tables. */
export function chainSlugFor(chainId: number): string | null {
  return CHAINS.find((c) => c.chainId === chainId)?.id ?? null
}

/**
 * A payment releases credit only when it was verified as tradable (status
 * recorded), has not been recorded before, and carries a positive value.
 * Refusals and replays never credit.
 */

/**
 * Route a verified payment to where the payer asked it to go: a key-tagged intent
 * funds that key, anything else credits the account ledger as before.
 */
async function creditVerified(
  userId: string,
  usdMicros: number,
  args: { chain: string; txHash: string; token: string },
  intentId?: string | null
) {
  if (intentId) {
    const it = await one('SELECT api_key_id FROM payment_intents WHERE id = $1 AND user_id = $2', [intentId, userId])
    if (it?.api_key_id) {
      const keyCredit = await creditKey(it.api_key_id, usdMicros)
      return { credited: true, to: 'key' as const, api_key_id: it.api_key_id, key_credit_usd_micros: keyCredit }
    }
  }
  const dep = await creditDeposit(userId, usdMicros, args)
  return { credited: (dep as any).credited, to: 'account' as const, deposit: dep }
}

export function shouldCreditPayment(args: { status: string; duplicate: boolean; usdMicros: number }): boolean {
  return args.status === 'recorded' && !args.duplicate && args.usdMicros > 0
}

/** The memo as stored on an intent, safe to echo back. */
function memoOf(intent: any | null) {
  if (!intent) return null
  return { id: intent.id, purpose: intent.purpose, memo: intent.memo, expected_usd: Number(intent.expected_usd_micros) / 1_000_000 }
}

/**
 * Persist a verified payment with its memo snapshotted. Idempotent: the unique
 * (chain, tx_hash, token, received_by) index means claiming the same transfer
 * twice cannot produce a second record, and so cannot credit twice later.
 */
async function recordPayment(args: {
  intent: any | null
  userId: string
  transfer: IncomingTransfer
  receivedAt: string
  usdMicros: number
  status: 'recorded' | 'refused' | 'pending_conversion'
  refusalCode: string | null
  priceUsd?: number | null
  pool?: string | null
}): Promise<{ paymentId: string; duplicate: boolean }> {
  const t = args.transfer
  const id = 'pay_' + randomBytes(9).toString('hex')
  const inserted = (
    await query(
      `INSERT INTO payments (id, intent_id, user_id, chain_id, token, tx_hash, received_by, sender,
                             raw_amount, decimals, usd_value_micros, price_usd, pool, purpose, memo, status, refusal_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (chain_id, tx_hash, token, received_by) DO NOTHING
       RETURNING id`,
      [id, args.intent?.id ?? null, args.userId, t.chain_id, t.token, t.tx_hash ?? null, args.receivedAt,
       t.from, t.raw_amount, t.decimals, args.usdMicros, args.priceUsd ?? null, args.pool ?? null,
       args.intent?.purpose ?? null, args.intent?.memo ?? null, args.status, args.refusalCode]
    )
  ).rows

  const duplicate = inserted.length === 0
  const paymentId = duplicate ? id : (inserted[0]?.id ?? id)

  if (!duplicate && args.intent?.id && args.status === 'recorded') {
    await query(`UPDATE payment_intents SET status = 'paid' WHERE id = $1 AND user_id = $2 AND status = 'open'`, [
      args.intent.id,
      args.userId,
    ])
  }
  return { paymentId, duplicate }
}

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
    const automation_receiver = env.platformAutomationReceiver || ''
    return c.json({
      receiver_address,
      agent_receiver,
      automation_receiver,
      configured: Boolean(receiver_address || agent_receiver || automation_receiver),
      receivers: [receiver_address, agent_receiver, automation_receiver].filter(Boolean),
      chains: CHAINS,
    })
  })

  // POST /api/payments/intent - the memo. ERC-20 transfers carry no memo field,
  // so the intent is created BEFORE money moves and remembered by id. Purpose is
  // required because it is what drives reporting; free-text memo is optional.
  app.post('/api/payments/intent', requireUser, async (c) => {
    const user = c.get('user')!
    let body: any
    try { body = await c.req.json() } catch { body = {} }
    const PURPOSES = ['api_credits', 'agent_budget', 'pay_per_call', 'plan_purchase', 'other']
    const purpose = String(body?.purpose || '').trim()
    if (!PURPOSES.includes(purpose)) {
      return c.json({ error: { message: `purpose must be one of ${PURPOSES.join(', ')}`, type: 'validation' } }, 400)
    }
    const expectedUsd = Number(body?.expected_usd ?? body?.expectedUsd ?? 0)
    if (!Number.isFinite(expectedUsd) || expectedUsd <= 0 || expectedUsd > 10000) {
      return c.json({ error: { message: 'expected_usd must be between 0.01 and 10000', type: 'validation' } }, 400)
    }
    // Memo is user text and is never authorisation: strip control chars, cap length.
    const memoRaw = typeof body?.memo === 'string' ? body.memo : ''
    const memo = memoRaw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || null
    const chainId = body?.chain_id != null ? Number(body.chain_id) : null
    // Optional key tag: funds attach to that key instead of the account balance.
    let keyId: string | null = null
    if (body?.api_key_id != null && body.api_key_id !== '') {
      const k = await one('SELECT id FROM api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [String(body.api_key_id), user.id])
      if (!k) return c.json({ error: { message: 'api_key_id must be one of your active keys', type: 'validation' } }, 400)
      keyId = String(body.api_key_id)
    }
    const ttlMinutes = Math.min(Math.max(Number(process.env.PAYMENT_INTENT_TTL_MINUTES || 30), 5), 1440)
    const id = 'pi_' + randomBytes(9).toString('hex')
    await query(
      `INSERT INTO payment_intents (id, user_id, purpose, memo, expected_usd_micros, chain_id, api_key_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' minutes')::interval)`,
      [id, user.id, purpose, memo, Math.round(expectedUsd * 1_000_000), chainId, keyId, String(ttlMinutes)]
    )
    const row = (await query(`SELECT id, purpose, memo, expected_usd_micros, chain_id, status, expires_at FROM payment_intents WHERE id = $1`, [id])).rows[0] as any
    return c.json({
      intent: {
        id: row.id,
        purpose: row.purpose,
        memo: row.memo,
        expected_usd: Number(row.expected_usd_micros) / 1_000_000,
        chain_id: row.chain_id,
        status: row.status,
        expires_at: row.expires_at,
      },
      // How to attach this payment to the memo.
      how_to_pay: {
        claim: 'Call POST /api/credits/payment-review with intent_id and the tx_hash after sending.',
        receivers: [env.platformReceiverAddress, env.platformAgentReceiver, env.platformAutomationReceiver].filter(Boolean),
        expires_in_minutes: ttlMinutes,
      },
    })
  })

  // GET /api/payments - the record: what each payment was for, who sent it, and
  // what it was worth in USD when it landed.
  app.get('/api/payments', requireUser, async (c) => {
    const user = c.get('user')!
    const rows = (await query(
      `SELECT p.id, p.intent_id, p.chain_id, p.token, p.tx_hash, p.received_by, p.sender,
              p.raw_amount, p.decimals, p.usd_value_micros, p.price_usd, p.purpose, p.memo,
              p.status, p.refusal_code, p.created_at
       FROM payments p WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [user.id]
    )).rows
    return c.json({
      payments: rows.map((r) => ({
        id: r.id,
        intent_id: r.intent_id,
        chain_id: r.chain_id,
        token: r.token,
        tx_hash: r.tx_hash,
        received_by: r.received_by,
        sender: r.sender,
        amount: Number(r.raw_amount) / 10 ** Number(r.decimals),
        usd_value: Number(r.usd_value_micros) / 1_000_000,
        price_usd: r.price_usd != null ? Number(r.price_usd) : null,
        purpose: r.purpose,
        memo: r.memo,
        status: r.status,
        refusal_code: r.refusal_code,
        created_at: r.created_at,
      })),
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
    const intentId = body?.intent_id ? String(body.intent_id) : null
    if (!chainId || !txHash) {
      return c.json({ error: { message: 'chain_id and tx_hash are required', type: 'validation' } }, 400)
    }
    // An intent may only be claimed by its owner.
    let intent: any = null
    if (intentId) {
      const rows = (await query(`SELECT * FROM payment_intents WHERE id = $1 AND user_id = $2`, [intentId, c.get('user')!.id])).rows
      intent = rows[0] ?? null
      if (!intent) return c.json({ error: { message: 'intent not found for this account', type: 'not_found' } }, 404)
    }
    const receivers = [env.platformReceiverAddress, env.platformAgentReceiver, env.platformAutomationReceiver].filter(Boolean) as string[]
    const found = await findIncomingTransfer({ chainId, txHash, receivers })
    if (!found.ok) {
      return c.json({ accepted: false, verification: { ok: false, code: found.code, message: found.message } }, 422)
    }
    const t = found.transfer
    // Ownership gate. Must run before anything is recorded or credited: the payments table is
    // first-claim-wins, so without this a third party could claim someone else's inbound
    // transfer and receive the credit when it settles.
    const ownership = checkSenderOwnership({ sender: t.from, sessionWallet: c.get('user')!.wallet })
    if (!ownership.ok) {
      return c.json(
        {
          accepted: false,
          verification: { ok: false, code: ownership.code, message: ownership.message, sender: t.from },
          intent: memoOf(intent),
        },
        403
      )
    }
    const prepared = await prepareAutoConvert({
      chainId,
      tokenAddress: t.token,
      amountRaw: BigInt(t.raw_amount),
      decimals: t.decimals,
    })
    const received_at =
      t.to === String(env.platformReceiverAddress || '').toLowerCase()
        ? 'treasury_vault'
        : t.to === String(env.platformAutomationReceiver || '').toLowerCase()
          ? 'automation_account'
          : 'agent_wallet'
    if (!prepared.ok) {
      await recordPayment({
        intent, userId: c.get('user')!.id, transfer: t, receivedAt: received_at,
        usdMicros: 0, status: 'refused', refusalCode: prepared.code,
      })
      return c.json(
        { accepted: false, received_at, verification: { ok: true, ...t }, intent: memoOf(intent), refusal: { code: prepared.code, message: prepared.message } },
        422
      )
    }
    const usdMicros = Math.round(prepared.analysis.amountUsd * 1_000_000)
    const chainSlugForPolicy = chainSlugFor(chainId)
    // Credit only what we actually hold as settlement money. A volatile token earns nothing
    // until a swap has settled; it is recorded and left pending instead.
    const decision = decideCredit({
      chainSlug: chainSlugForPolicy ?? '',
      token: t.token,
      oracleMicros: usdMicros,
    })
    const recorded = await recordPayment({
      intent, userId: c.get('user')!.id, transfer: t, receivedAt: received_at,
      usdMicros, status: decision.status === 'credited' ? 'recorded' : 'pending_conversion',
      refusalCode: decision.status === 'credited' ? null : decision.status,
      priceUsd: prepared.analysis.priceUsd, pool: prepared.analysis.poolAddress,
    })

    // Release credit only for a first-time, tradable payment. creditDeposit is
    // itself idempotent per (chain, tx, token), so a replay cannot double-credit
    // even if two claims race past the payments uniqueness check.
    let credited = false
    let balanceMicros: number | null = null
    const chainSlug = chainSlugFor(chainId)
    if (decision.status !== 'credited') {
      // No credit yet: the payment is stored, the token sits with us, and the user is told
      // exactly why. Converting and releasing it is a separate, auditable step.
      return c.json({
        accepted: true,
        received_at,
        verification: { ok: true, ...t },
        intent: memoOf(intent),
        payment_id: recorded.paymentId,
        credited: false,
        credit_status: decision.status,
        credit_reason: decision.reason,
        oracle_usd: usdMicros / 1_000_000,
        next_step: decision.status === 'pending_conversion'
          ? 'This token is not a settlement asset, so no spendable credit is issued yet. Once the deposit is converted to ' +
            (chainSlugForPolicy ? String(CHAINS.find((c: any) => c.id === chainSlugForPolicy)?.settlement?.symbol ?? 'the settlement stablecoin') : 'the settlement stablecoin') +
            ', the realised amount is credited automatically.'
          : 'The received token valued at zero, so nothing was credited.',
      })
    }
    if (chainSlug && shouldCreditPayment({ status: 'recorded', duplicate: recorded.duplicate, usdMicros })) {
      const dep = await creditVerified(c.get('user')!.id, usdMicros, { chain: chainSlug, txHash: t.tx_hash, token: t.token }, (intent as any)?.id ?? null)
      credited = Boolean(dep.credited)
      balanceMicros = dep.to === 'account' ? (dep.deposit as any).balance : await getBalanceMicros(c.get('user')!.id)
    } else if (recorded.duplicate) {
      balanceMicros = await getBalanceMicros(c.get('user')!.id)
    }
    return c.json({
      accepted: true,
      received_at,
      verification: { ok: true, ...t },
      intent: memoOf(intent),
      payment_id: recorded.paymentId,
      duplicate: recorded.duplicate,
      credited,
      balance_usd_micros: balanceMicros,
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

    // Optionally load a specific key instead of the shared account balance. The key must
    // belong to the caller, so a deposit can never be pointed at someone else's key.
    const targetKeyId = body?.api_key_id ? String(body.api_key_id) : null
    if (targetKeyId) {
      const owned = await one('SELECT id FROM api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [targetKeyId, user.id])
      if (!owned) {
        return c.json({ error: { message: 'api_key_id must be one of your active keys', type: 'validation' } }, 400)
      }
      const dep = await creditDeposit(user.id, verification.amount_usd_micros, { chain, txHash: tx_hash, token: verification.token }, { toKeyId: targetKeyId })
      if (!dep.credited) {
        return c.json({ credited: false, loaded_to: 'key', api_key_id: targetKeyId, reason: 'already_credited' })
      }
      return c.json({
        credited: true,
        loaded_to: 'key',
        api_key_id: targetKeyId,
        key_credit_usd_micros: dep.keyCredit ?? null,
        balance_usd_micros: dep.balance,
      })
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
