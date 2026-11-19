import { randomBytes } from 'node:crypto'
import { one, query, tx } from '../db/index.js'
import { CREDITABLE_STATES } from '../payments/finality.js'
import { CREDITABLE_STATUSES } from '../payments/settle.js'
import { newId } from './env.js'

/**
 * Prepaid credit ledger. All amounts are signed USD micros.
 * Inflow (deposits) and outflow (usage spend) recorded here — this is also the
 * source for the /api/stats tokenized-stocks feed.
 */

export async function getBalanceMicros(userId: string): Promise<number> {
  const r = await one('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
  return Number(r?.bal ?? 0)
}

/**
 * Charge a request. Returns ok:false when the balance is insufficient and no
 * allowance covers the wallet. A covered wallet is charged anyway so the cost
 * stays visible in the ledger, which is why the balance may go negative.
 */
export async function debitForUsage(
  userId: string,
  costMicros: number,
  ref: string,
  opts: { allowNegative?: boolean } = {}
): Promise<{ ok: boolean; balance: number }> {
  if (costMicros <= 0) return { ok: true, balance: await getBalanceMicros(userId) }
  return tx(async (q) => {
    // Serialize per-user debits
    await q('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
    const b = await q('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
    const balance = Number(b.rows[0]?.bal ?? 0)
    if (balance < costMicros && !opts.allowNegative) return { ok: false, balance }
    await q('INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)', [userId, -costMicros, 'usage', ref])
    return { ok: true, balance: balance - costMicros }
  })
}

/** Credit a verified on-chain deposit. Idempotent per (chain, txHash, token). */
export async function creditDeposit(
  userId: string,
  amountMicros: number,
  ref: { chain: string; txHash: string; token: string },
  opts: { toKeyId?: string | null } = {}
): Promise<{
  credited: boolean
  balance: number
  keyCredit?: number
  /**
   * Set on a replay: the account that already owns the deposits row for this transfer, or null when
   * nothing matched. A caller uses it to tell "this transfer's credit is already on this user's
   * balance" from "somebody else claimed this transfer first", which are opposite conclusions.
   */
  existingUserId?: string | null
  /** Destination persisted on the first successful claim: null = account, otherwise API key id. */
  existingToKeyId?: string | null
  /** True when this user is replaying the same transfer but asking for a different destination. */
  destinationConflict?: boolean
}> {
  return tx(async (q) => {
    await q('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
    const dep = await q(
      `INSERT INTO deposits (id, user_id, chain, token, tx_hash, amount_usd_micros, to_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain, tx_hash, token) DO NOTHING RETURNING id`,
      [newId(), userId, ref.chain, ref.token.toLowerCase(), ref.txHash.toLowerCase(), amountMicros, opts.toKeyId]
    )
    if (!dep.rows[0]) {
      const owner = await q('SELECT user_id, to_key_id FROM deposits WHERE chain = $1 AND tx_hash = $2 AND token = $3', [
        ref.chain,
        ref.txHash.toLowerCase(),
        ref.token.toLowerCase(),
      ])
      const b = await q('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
      const existingUserId = (owner.rows[0]?.user_id as string | undefined) ?? null
      const existingToKeyId = (owner.rows[0]?.to_key_id as string | undefined) ?? null
      const requestedToKeyId = opts.toKeyId ?? null
      return {
        credited: false,
        balance: Number(b.rows[0]?.bal ?? 0),
        existingUserId,
        existingToKeyId,
        destinationConflict: existingUserId === userId && existingToKeyId !== requestedToKeyId,
      }
    }
    // A key-tagged deposit loads that key: the deposits row keeps the real amount and the
    // replay protection, while the money lands on the key instead of the account ledger.
    const balNow = async () => {
      const b = await q('SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1', [userId])
      return Number(b.rows[0]?.bal ?? 0)
    }
    if (opts.toKeyId) {
      const k = await q('UPDATE api_keys SET credit_usd_micros = credit_usd_micros + $1 WHERE id = $2 RETURNING credit_usd_micros', [amountMicros, opts.toKeyId])
      if (!k.rows[0]) throw new Error('api key not found for deposit credit')
      return { credited: true, balance: await balNow(), keyCredit: Number(k.rows[0].credit_usd_micros) }
    }
    await q('INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)', [
      userId, amountMicros, 'deposit', `${ref.chain}:${ref.txHash}`,
    ])
    return { credited: true, balance: await balNow() }
  })
}

/**
 * Credit a payment and move its payment row to credited under one database transaction.
 *
 * The payment row is locked before the idempotency insert. If reorg handling wins the lock first,
 * this function sees the reorg state and refuses to move money. If this function wins first, a later
 * reorg transition sees credited and escalates to reconciliation. The deposit, destination, ledger
 * or key balance, payment state, and audit event commit or roll back together.
 */
export async function creditPaymentDeposit(
  paymentId: string,
  userId: string,
  amountMicros: number,
  ref: { chain: string; chainId: number; txHash: string; token: string; rawAmount: string; decimals: number },
  opts: { toKeyId?: string | null; intentId?: string | null; receivedBy: string; confirmations: number; requiredConfirmations: number }
): Promise<{
  credited: boolean
  settled: boolean
  state: string | null
  reconciliation: boolean
  destinationConflict: boolean
  scopeConflict: boolean
  ownershipConflict: boolean
  reason?: string
  balance: number
  keyCredit?: number
}> {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
    throw new Error('A payment credit must be a positive integer number of USD micros')
  }
  if (!Number.isSafeInteger(opts.confirmations) || !Number.isSafeInteger(opts.requiredConfirmations) ||
      opts.requiredConfirmations < 1 || opts.confirmations < opts.requiredConfirmations) {
    return {
      credited: false, settled: false, state: null, reconciliation: false,
      destinationConflict: false, scopeConflict: false, ownershipConflict: false,
      reason: 'insufficient_confirmations', balance: 0,
    }
  }

  if (!Number.isSafeInteger(ref.chainId) || ref.chainId <= 0 ||
      !/^\d+$/.test(ref.rawAmount) || BigInt(ref.rawAmount) <= 0n ||
      !Number.isSafeInteger(ref.decimals) || ref.decimals < 0 || ref.decimals > 36) {
    throw new Error('A payment settlement requires a complete verified transfer identity')
  }

  return tx(async (q) => {
    // Global lock order for intent-bound settlements is payment_intents -> payments.
    // Read the immutable intent pointer without locking, lock the intent first, then lock
    // and revalidate the payment row. recordPayment uses the same order when claiming
    // a different transfer against an intent.
    const pointer = await q(
      `SELECT intent_id FROM payments WHERE id = $1 AND user_id = $2`,
      [paymentId, userId]
    )
    if (!pointer.rows[0]) {
      return {
        credited: false, settled: false, state: null, reconciliation: false,
        destinationConflict: false, scopeConflict: false, ownershipConflict: false,
        reason: 'payment_not_found', balance: 0,
      }
    }
    const pointedIntentId = pointer.rows[0].intent_id ?? null
    let lockedIntent: any = null
    if (pointedIntentId) {
      const intentLock = await q(
        `SELECT id, status FROM payment_intents
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [pointedIntentId, userId]
      )
      lockedIntent = intentLock.rows[0] ?? null
    }

    const paymentResult = await q(
      `SELECT id, user_id, state, status, intent_id, to_key_id,
              chain_id, tx_hash, token, received_by, raw_amount, decimals, usd_value_micros
         FROM payments
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [paymentId, userId]
    )
    const payment = paymentResult.rows[0]
    if (!payment) {
      return {
        credited: false, settled: false, state: null, reconciliation: false,
        destinationConflict: false, scopeConflict: false, ownershipConflict: false,
        reason: 'payment_not_found', balance: 0,
      }
    }

    if (payment.state === 'reorged' || payment.state === 'needs_reconciliation') {
      return {
        credited: false, settled: false, state: payment.state,
        reconciliation: payment.state === 'needs_reconciliation',
        destinationConflict: false, scopeConflict: false, ownershipConflict: false,
        reason: 'payment_requires_reconciliation', balance: 0,
      }
    }

    const storedIntentId = payment.intent_id ?? null
    const storedToKeyId = payment.to_key_id ?? null
    if (storedIntentId !== pointedIntentId) {
      return {
        credited: false, settled: false, state: payment.state, reconciliation: false,
        destinationConflict: false, scopeConflict: true, ownershipConflict: false,
        reason: 'payment_intent_changed_during_settlement', balance: 0,
      }
    }
    const identityMatches =
      Number(payment.chain_id) === ref.chainId &&
      String(payment.tx_hash).toLowerCase() === ref.txHash.toLowerCase() &&
      String(payment.token).toLowerCase() === ref.token.toLowerCase() &&
      payment.received_by === opts.receivedBy &&
      String(payment.raw_amount) === ref.rawAmount &&
      Number(payment.decimals) === ref.decimals &&
      String(payment.usd_value_micros) === String(amountMicros)
    if (!identityMatches) {
      return {
        credited: false, settled: false, state: payment.state, reconciliation: false,
        destinationConflict: false, scopeConflict: true, ownershipConflict: false,
        reason: 'payment_identity_mismatch', balance: 0,
      }
    }
    if (storedIntentId !== (opts.intentId ?? null)) {
      return {
        credited: false, settled: false, state: payment.state, reconciliation: false,
        destinationConflict: false, scopeConflict: true, ownershipConflict: false,
        reason: 'payment_intent_mismatch', balance: 0,
      }
    }
    if (storedToKeyId !== (opts.toKeyId ?? null)) {
      return {
        credited: false, settled: false, state: payment.state, reconciliation: false,
        destinationConflict: true, scopeConflict: false, ownershipConflict: false,
        reason: 'payment_destination_mismatch', balance: 0,
      }
    }
    if (payment.state === 'credited') {
      const existing = await q(
        `SELECT user_id, to_key_id, payment_id, received_by FROM deposits
          WHERE chain = $1 AND tx_hash = $2 AND token = $3`,
        [ref.chain, ref.txHash.toLowerCase(), ref.token.toLowerCase()]
      )
      const row = existing.rows[0]
      const sameOwner = row?.user_id === userId
      const sameDestination = (row?.to_key_id ?? null) === (storedToKeyId)
      const sameScope = row?.payment_id === paymentId && row?.received_by === opts.receivedBy
      const balanceRow = await q(
        `SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1`,
        [userId]
      )
      let existingKeyCredit: number | undefined
      if (storedToKeyId && sameOwner && sameDestination) {
        const key = await q('SELECT credit_usd_micros FROM api_keys WHERE id = $1 AND user_id = $2', [storedToKeyId, userId])
        existingKeyCredit = key.rows[0] ? Number(key.rows[0].credit_usd_micros) : undefined
      }
      return {
        credited: false, settled: Boolean(sameOwner && sameDestination && sameScope), state: 'credited',
        reconciliation: false, destinationConflict: Boolean(sameOwner && !sameDestination),
        scopeConflict: Boolean(sameOwner && sameDestination && !sameScope),
        ownershipConflict: Boolean(row && !sameOwner),
        reason: 'already_credited', balance: Number(balanceRow.rows[0]?.bal ?? 0),
        keyCredit: existingKeyCredit,
      }
    }
    if (!CREDITABLE_STATES.has(payment.state) || !CREDITABLE_STATUSES.includes(payment.status)) {
      return {
        credited: false, settled: false, state: payment.state, reconciliation: false,
        destinationConflict: false, scopeConflict: false, ownershipConflict: false,
        reason: 'payment_not_creditable', balance: 0,
      }
    }

    if (storedIntentId) {
      if (!lockedIntent || lockedIntent.status !== 'open') {
        return {
          credited: false, settled: false, state: payment.state, reconciliation: false,
          destinationConflict: false, scopeConflict: true, ownershipConflict: false,
          reason: 'payment_intent_not_open', balance: 0,
        }
      }
    }

    const inserted = await q(
      `INSERT INTO deposits (id, user_id, chain, token, tx_hash, amount_usd_micros, to_key_id, payment_id, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (chain, tx_hash, token) DO NOTHING
       RETURNING id`,
      [newId(), userId, ref.chain, ref.token.toLowerCase(), ref.txHash.toLowerCase(), amountMicros, storedToKeyId, paymentId, opts.receivedBy]
    )

    let creditedNow = Boolean(inserted.rows[0])
    let keyCredit: number | undefined
    if (!creditedNow) {
      const existing = await q(
        `SELECT user_id, to_key_id, payment_id, received_by FROM deposits
          WHERE chain = $1 AND tx_hash = $2 AND token = $3
          FOR UPDATE`,
        [ref.chain, ref.txHash.toLowerCase(), ref.token.toLowerCase()]
      )
      const row = existing.rows[0]
      const sameOwner = row?.user_id === userId
      const sameDestination = (row?.to_key_id ?? null) === (storedToKeyId)
      const sameScope = row?.payment_id === paymentId && row?.received_by === opts.receivedBy
      if (!sameOwner) {
        return {
          credited: false, settled: false, state: payment.state, reconciliation: false,
          destinationConflict: false, scopeConflict: false, ownershipConflict: true,
          reason: 'deposit_already_owned', balance: 0,
        }
      }
      if (!sameScope) {
        return {
          credited: false, settled: false, state: payment.state, reconciliation: false,
          destinationConflict: false, scopeConflict: true, ownershipConflict: false,
          reason: 'deposit_payment_scope_conflict', balance: 0,
        }
      }
      if (!sameDestination) {
        return {
          credited: false, settled: false, state: payment.state, reconciliation: false,
          destinationConflict: true, scopeConflict: false, ownershipConflict: false,
          reason: 'deposit_destination_conflict', balance: 0,
        }
      }
      if (storedToKeyId) {
        const key = await q('SELECT credit_usd_micros FROM api_keys WHERE id = $1 AND user_id = $2', [storedToKeyId, userId])
        keyCredit = key.rows[0] ? Number(key.rows[0].credit_usd_micros) : undefined
      }
    } else if (storedToKeyId) {
      const key = await q(
        `UPDATE api_keys
            SET credit_usd_micros = credit_usd_micros + $1
          WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL
          RETURNING credit_usd_micros`,
        [amountMicros, storedToKeyId, userId]
      )
      if (!key.rows[0]) throw new Error('active API key not found for deposit credit')
      keyCredit = Number(key.rows[0].credit_usd_micros)
    } else {
      await q(
        `INSERT INTO ledger (user_id, amount_usd_micros, kind, ref)
         VALUES ($1, $2, 'deposit', $3)`,
        [userId, amountMicros, `${ref.chain}:${ref.txHash}`]
      )
    }

    const updated = await q(
      `UPDATE payments
          SET state = 'credited',
              credited_at = COALESCE(credited_at, now()),
              usd_value_micros = CASE WHEN $2::bigint > 0 THEN $2::bigint ELSE usd_value_micros END,
              confirmations = $5,
              status = CASE WHEN status = 'pending_confirmations' THEN 'recorded' ELSE status END
        WHERE id = $1
          AND state = ANY($3::text[])
          AND status = ANY($4::text[])
        RETURNING intent_id`,
      [paymentId, amountMicros, [...CREDITABLE_STATES], [...CREDITABLE_STATUSES], opts.confirmations]
    )
    if (!updated.rows[0]) throw new Error('Payment state changed while its row lock was held; credit transaction aborted')

    await q(
      `INSERT INTO payment_events (id, payment_id, kind, detail)
       VALUES ($1, $2, 'credited', $3)`,
      [
        'pev_' + randomBytes(9).toString('hex'),
        paymentId,
        JSON.stringify({
          usd_micros: amountMicros,
          destination: storedToKeyId ? 'api_key' : 'account',
          api_key_id: storedToKeyId,
          confirmations: opts.confirmations,
          required_confirmations: opts.requiredConfirmations,
        }),
      ]
    )
    if (updated.rows[0].intent_id) {
      const intentUpdate = await q(
        `UPDATE payment_intents SET status = 'paid'
          WHERE id = $1 AND status = 'open'
          RETURNING id`,
        [updated.rows[0].intent_id]
      )
      if (!intentUpdate.rows[0]) throw new Error('Payment intent changed before settlement commit')
    }

    const balance = await q(
      `SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal
         FROM ledger WHERE user_id = $1`,
      [userId]
    )
    return {
      credited: creditedNow, settled: true, state: 'credited', reconciliation: false,
      destinationConflict: false, scopeConflict: false, ownershipConflict: false,
      balance: Number(balance.rows[0]?.bal ?? 0), keyCredit,
    }
  })
}

export async function adjustCredit(userId: string, amountMicros: number, reason: string): Promise<void> {
  await query('INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)', [
    userId, amountMicros, 'adjust', reason,
  ])
}
