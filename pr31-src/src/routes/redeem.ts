import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { query, one, tx } from '../db/index.js'
import { getBalanceMicros } from '../lib/billing.js'
import { newId, platformReceivers } from '../lib/env.js'
import { CHAINS } from '../payments/chains.js'
import { analyseToken } from '../payments/market.js'
import {
  redeemPolicyFromEnv,
  checkRedeemRequest,
  minPayoutRaw,
  isQuoteExpired,
  readTokenDecimals,
  usd,
} from '../payments/redeem.js'
import { createPublicClient, http, parseAbi } from 'viem'

const TOKEN_RE = /^0x[0-9a-fA-F]{40}$/
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** rows that count against today's ceiling: a quote is a promise we may have to honour. */
const COUNTING_STATUSES = ['quoted', 'settled']

function err(c: any, code: string, message: string, status: number) {
  return c.json({ error: { message, type: 'billing', code } }, status)
}

async function dailySpentMicros(userId: string): Promise<number> {
  const r = await one(
    `SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS spent
       FROM redemptions
      WHERE user_id = $1
        AND status = ANY($2)
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc')`,
    [userId, COUNTING_STATUSES]
  )
  return Number(r?.spent ?? 0)
}

export function registerRedeemRoutes(app: SessionApp): void {
  /**
   * Price a payout. Read-only against the ledger and the market: no credits move here, and the
   * row it writes is a quote, which is why an abandoned quote costs nothing but a stale row.
   *
   * The recipient is not a parameter. A payout always lands in the caller's own registered
   * wallet, for the same reason the deposit route refuses a key the caller does not own: an
   * endpoint that pays any address you name is a way to launder a stolen session into a transfer.
   */
  app.post('/api/credits/redeem/quote', requireUser, async (c) => {
    const policy = redeemPolicyFromEnv()
    if (!policy.enabled) {
      return err(c, 'redeem_disabled', 'Redemptions are disabled on this deployment', 503)
    }

    const user = c.get('user')!
    if (!user.wallet) {
      return err(c, 'wallet_required', 'Connect a wallet first: a payout needs somewhere to land', 400)
    }

    let body: any = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }

    const chainId = Number(body?.chain_id ?? body?.chainId ?? 8453)
    const cfg = CHAINS.find((x) => x.chainId === chainId)
    if (!cfg) return err(c, 'unsupported_chain', `Chain ${chainId} is not configured`, 400)

    const token = String(body?.token ?? body?.token_address ?? '')
    if (!TOKEN_RE.test(token)) return err(c, 'invalid_token', 'token must be a 0x-prefixed ERC-20 address', 400)

    const amountUsdMicros = body?.amount_usd_micros !== undefined
      ? Number(body.amount_usd_micros)
      : Math.round(Number(body?.amount_usd ?? 0) * 1_000_000)

    const decimals = await readTokenDecimals(chainId, token)
    if (decimals === null) {
      return err(c, 'unsupported_token', 'Token does not report usable decimals(); refusing to guess its scale', 422)
    }

    const balance = await getBalanceMicros(user.id)
    const spent = await dailySpentMicros(user.id)
    const verdict = checkRedeemRequest({ amountUsdMicros, balanceMicros: balance, dailySpentMicros: spent, policy })
    if (!verdict.ok) return err(c, verdict.code, verdict.message, 422)

    // Price discovery in two steps: a single token establishes price and the pool, then the real
    // size is analysed again so the impact figure describes the trade we would actually do.
    const unit = await analyseToken({
      chainId,
      tokenAddress: token,
      amountRaw: 10n ** BigInt(decimals),
      decimals,
      policy: policy.market,
    })
    if (!unit.tradable || !Number.isFinite(unit.priceUsd) || unit.priceUsd <= 0) {
      const code = unit.tradable ? 'price_unavailable' : (unit as any).code ?? 'not_tradable'
      const message = unit.tradable ? 'No usable price for this token right now' : (unit as any).message
      return err(c, String(code), String(message), 422)
    }

    const expectedTokens = amountUsdMicros / 1_000_000 / unit.priceUsd
    const expectedOutRaw = BigInt(Math.floor(expectedTokens * 10 ** decimals))
    if (expectedOutRaw <= 0n) {
      return err(c, 'amount_too_small', 'At the current price this redemption would round down to zero tokens', 422)
    }

    const atSize = await analyseToken({ chainId, tokenAddress: token, amountRaw: expectedOutRaw, decimals, policy: policy.market })
    if (!atSize.tradable) {
      return err(c, String((atSize as any).code ?? 'not_tradable'), String((atSize as any).message), 422)
    }

    const minOutRaw = minPayoutRaw(expectedOutRaw, policy.slippageBps)
    const idempotencyKey = body?.idempotency_key ? String(body.idempotency_key).slice(0, 120) : null
    const expiresAt = new Date(Date.now() + policy.quoteTtlSeconds * 1000)

    const insert = async () =>
      one(
        `INSERT INTO redemptions
           (id, user_id, chain_id, token, symbol, decimals, amount_usd_micros,
            expected_out_raw, min_out_raw, price_usd, pool, status, idempotency_key, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'quoted',$12,$13)
         RETURNING *`,
        [
          newId(), user.id, chainId, token.toLowerCase(),
          cfg.tokens.find((t) => t.address.toLowerCase() === token.toLowerCase())?.symbol ?? null,
          decimals, amountUsdMicros, expectedOutRaw.toString(), minOutRaw.toString(),
          unit.priceUsd, atSize.poolAddress ?? null, idempotencyKey, expiresAt.toISOString(),
        ]
      )

    let row: any
    try {
      row = await insert()
    } catch (e: any) {
      // A retried request with the same key returns the quote it already made, never a second one.
      if (String(e?.code) === '23505' && idempotencyKey) {
        row = await one('SELECT * FROM redemptions WHERE user_id = $1 AND idempotency_key = $2', [user.id, idempotencyKey])
        if (!row) return err(c, 'conflict', 'A quote with this idempotency_key already exists', 409)
        return c.json({ redemption: shape(row), replayed: true })
      }
      throw e
    }

    return c.json({
      redemption: shape(row),
      quote: {
        chain_id: chainId,
        token: token.toLowerCase(),
        recipient: user.wallet,
        amount_usd_micros: amountUsdMicros,
        expected_out_raw: expectedOutRaw.toString(),
        min_out_raw: minOutRaw.toString(),
        price_usd: unit.priceUsd,
        impact_bps: atSize.impactBps ?? null,
        liquidity_usd: atSize.liquidityUsd ?? null,
        volume_24h_usd: atSize.volume24hUsd ?? null,
        pool: atSize.poolAddress ?? null,
        slippage_bps: policy.slippageBps,
        expires_at: expiresAt.toISOString(),
        settlement: 'The platform sends the asset to your wallet, then submit the payout tx hash to convert this quote against your credits.',
      },
      balance_usd_micros: balance,
      daily_spent_usd_micros: spent,
      daily_cap_usd_micros: policy.maxPerDayMicros,
    })
  })

  /**
   * Settle a quote against a real transfer.
   *
   * This is the only place credits are debited, and the transfer is verified first: token, sender
   * in the platform's receiver set, recipient the caller's own wallet, amount at or above the
   * quoted floor. A payout we cannot see debits nothing.
   */
  app.post('/api/credits/redeem/:id/payout-tx', requireUser, async (c) => {
    const policy = redeemPolicyFromEnv()
    if (!policy.enabled) {
      return err(c, 'redeem_disabled', 'Redemptions are disabled on this deployment', 503)
    }

    const user = c.get('user')!
    const id = c.req.param('id')
    const row = await one('SELECT * FROM redemptions WHERE id = $1 AND user_id = $2', [id, user.id])
    if (!row) return err(c, 'not_found', 'No such redemption for this account', 404)
    if (row.status === 'settled') return c.json({ redemption: shape(row), settled: false, reason: 'already_settled' })
    if (row.status === 'cancelled') return err(c, 'cancelled', 'This quote was cancelled', 409)

    let body: any = {}
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const txHash = String(body?.tx_hash ?? body?.txHash ?? '')
    if (!TOKEN_RE.test(txHash)) return err(c, 'invalid_tx_hash', 'tx_hash must be a 0x-prefixed transaction hash', 400)

    const cfg = CHAINS.find((x) => x.chainId === Number(row.chain_id))
    if (!cfg) return err(c, 'unsupported_chain', `Chain ${row.chain_id} is not configured`, 400)

    const receivers = new Set(platformReceivers().map((a) => a.toLowerCase()).filter(Boolean))
    const recipient = String(user.wallet || '').toLowerCase()
    const minOut = BigInt(row.min_out_raw)

    let receipt: any
    try {
      const client = createPublicClient({ transport: http(cfg.rpc) })
      receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
    } catch {
      return err(c, 'tx_not_found', 'That transaction is not visible on chain yet. Try again once it confirms.', 404)
    }
    if (!receipt || receipt.status !== 'success') {
      return err(c, 'tx_failed', 'That transaction did not succeed, so nothing is owed against it', 422)
    }

    const token = String(row.token).toLowerCase()
    let matched: bigint | null = null
    let sawRecipient = false
    let sawToken = false
    for (const log of receipt.logs ?? []) {
      if (String(log.address).toLowerCase() !== token) continue
      sawToken = true
      if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue
      const from = `0x${String(log.topics[1]).slice(-40)}`.toLowerCase()
      const to = `0x${String(log.topics[2]).slice(-40)}`.toLowerCase()
      if (to !== recipient) continue
      sawRecipient = true
      if (!receivers.has(from)) continue
      const value = BigInt(log.data)
      if (matched === null || value > matched) matched = value
    }

    if (!sawToken) return err(c, 'wrong_token', 'That transaction contains no transfer of the quoted token', 422)
    if (!sawRecipient) return err(c, 'wrong_recipient', 'No transfer of the quoted token reached your registered wallet', 422)
    if (matched === null) return err(c, 'wrong_sender', 'The transfer in that transaction did not come from a platform wallet', 422)
    if (matched < minOut) {
      return err(
        c,
        'below_quote',
        `The transfer paid ${matched} raw units, below the quoted floor of ${minOut} for this redemption`,
        422
      )
    }

    // Settle: verify balance under a row lock, debit once, flip the quote. The unique index on
    // payout_tx_hash is the replay guard, so the same transfer can never settle two redemptions.
    try {
      const result = await tx(async (q) => {
        await q('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id])
        const b = await q('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [user.id])
        const balance = Number(b.rows[0]?.bal ?? 0)
        if (balance < Number(row.amount_usd_micros)) {
          return { ok: false as const, code: 'insufficient_credits', balance }
        }
        const upd = await q(
          `UPDATE redemptions
              SET status = 'settled', payout_tx_hash = $1, settled_at = now()
            WHERE id = $2 AND status = 'quoted'
            RETURNING id`,
          [txHash.toLowerCase(), row.id]
        )
        if (!upd.rows[0]) return { ok: false as const, code: 'already_settled', balance }
        await q('INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)', [
          user.id,
          -Number(row.amount_usd_micros),
          'redeem',
          `redeem:${row.id}:${txHash.toLowerCase()}`,
        ])
        return { ok: true as const, balance: balance - Number(row.amount_usd_micros) }
      })

      if (!result.ok) {
        const status = result.code === 'insufficient_credits' ? 422 : 409
        return err(c, result.code, result.code === 'insufficient_credits'
          ? 'The balance no longer covers this redemption'
          : 'This redemption was already settled', status)
      }

      const fresh = await one('SELECT * FROM redemptions WHERE id = $1', [row.id])
      return c.json({
        redemption: shape(fresh),
        settled: true,
        debited_usd_micros: Number(row.amount_usd_micros),
        paid_out_raw: matched.toString(),
        balance_usd_micros: result.balance,
      })
    } catch (e: any) {
      // Same transfer presented for a second redemption: the unique index refuses it.
      if (String(e?.code) === '23505') {
        return err(c, 'replayed_payout', 'That payout transaction has already been used to settle a redemption', 409)
      }
      throw e
    }
  })

  /** The account's redemption ledger, plus what today still allows. */
  app.get('/api/credits/redeem', requireUser, async (c) => {
    const policy = redeemPolicyFromEnv()
    const user = c.get('user')!
    const rows = await query(
      'SELECT * FROM redemptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25',
      [user.id]
    )
    const balance = await getBalanceMicros(user.id)
    const spent = await dailySpentMicros(user.id)
    return c.json({
      enabled: policy.enabled,
      balance_usd_micros: balance,
      daily_spent_usd_micros: spent,
      daily_cap_usd_micros: policy.maxPerDayMicros,
      limits: {
        min_usd_micros: policy.minUsdMicros,
        max_per_call_usd_micros: policy.maxPerCallMicros,
        slippage_bps: policy.slippageBps,
      },
      redemptions: (rows.rows ?? rows).map(shape),
    })
  })

  /** Abandon a quote before it is paid. Settled rows are immutable. */
  app.post('/api/credits/redeem/:id/cancel', requireUser, async (c) => {
    const user = c.get('user')!
    const id = c.req.param('id')
    const upd = await one(
      `UPDATE redemptions SET status = 'cancelled'
        WHERE id = $1 AND user_id = $2 AND status = 'quoted'
        RETURNING *`,
      [id, user.id]
    )
    if (!upd) return err(c, 'not_cancellable', 'Only an open quote can be cancelled; settled redemptions cannot', 409)
    return c.json({ redemption: shape(upd), cancelled: true })
  })
}

/** One shape for a redemption in every response, so clients never parse two schemas. */
function shape(row: any) {
  return {
    id: row.id,
    chain_id: Number(row.chain_id),
    token: row.token,
    symbol: row.symbol,
    decimals: Number(row.decimals),
    amount_usd_micros: Number(row.amount_usd_micros),
    amount_usd: usd(Number(row.amount_usd_micros)),
    expected_out_raw: String(row.expected_out_raw),
    min_out_raw: String(row.min_out_raw),
    price_usd: row.price_usd === null ? null : Number(row.price_usd),
    pool: row.pool,
    status: row.status,
    payout_tx_hash: row.payout_tx_hash,
    quote_expired: isQuoteExpired(row.expires_at),
    expires_at: row.expires_at,
    settled_at: row.settled_at,
    created_at: row.created_at,
  }
}
