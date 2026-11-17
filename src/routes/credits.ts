import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { env, depositAddress, platformReceivers } from '../lib/env.js'
import { one, query, tx } from '../db/index.js'
import { getBalanceMicros, creditPaymentDeposit } from '../lib/billing.js'
import { decideCredit } from '../lib/creditPolicy.js'
import { CHAINS, isPolicyPricedToken, platformTokenUsdMicros } from '../payments/chains.js'
import { verifyDeposit } from '../payments/verify.js'
import { findIncomingTransfer, checkSenderOwnership } from '../payments/verify.js'
import { prepareAutoConvert, autoConvertPolicyFromEnv } from '../payments/autoConvert.js'
import { decideSettlement, type FinalityVerdict } from '../payments/finality.js'
import { markReorged, paymentStateFor } from '../payments/settle.js'
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
  intentId: string | null,
  toKeyId: string | null,
  paymentId: string,
  finality: FinalityVerdict,
  receivedBy: string
) {
  const dep = await creditPaymentDeposit(paymentId, userId, usdMicros, args, {
    intentId,
    toKeyId,
    receivedBy,
    confirmations: finality.confirmations,
    requiredConfirmations: finality.required,
  })
  return {
    credited: dep.credited,
    settled: dep.settled,
    destinationConflict: dep.destinationConflict,
    scopeConflict: dep.scopeConflict,
    ownershipConflict: dep.ownershipConflict,
    reconciliation: dep.reconciliation,
    reason: dep.reason,
    to: toKeyId ? ('key' as const) : ('account' as const),
    api_key_id: toKeyId,
    key_credit_usd_micros: dep.keyCredit ?? null,
    deposit: dep,
  }
}

function claimConflictResponse(c: any, claim: { scopeConflict: boolean; destinationConflict: boolean; ownershipConflict: boolean; intentConflict: boolean }) {
  if (!claim.scopeConflict && !claim.destinationConflict && !claim.ownershipConflict && !claim.intentConflict) return null
  return c.json({
    accepted: false,
    error: {
      code: claim.ownershipConflict ? 'payment_already_claimed' : claim.intentConflict ? 'payment_intent_unavailable' : claim.scopeConflict ? 'payment_intent_conflict' : 'payment_destination_conflict',
      message: 'This transfer is already bound to a different payment intent or credit destination. No new credit was issued.',
    },
  }, 409)
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
export async function recordPayment(args: {
  intent: any | null
  userId: string
  transfer: IncomingTransfer
  receivedAt: string
  usdMicros: number
  status: 'recorded' | 'refused' | 'pending_conversion' | 'pending_confirmations'
  refusalCode: string | null
  priceUsd?: number | null
  pool?: string | null
  /** Immutable account-vs-key destination captured when the transfer is first claimed. */
  toKeyId?: string | null
  state?: string
  confirmations?: number
  requiredConfirmations?: number
  observedBlock?: number | null
}): Promise<{
  paymentId: string
  duplicate: boolean
  state: string | null
  intentId: string | null
  toKeyId: string | null
  scopeConflict: boolean
  destinationConflict: boolean
  ownershipConflict: boolean
  intentConflict: boolean
}> {
  const t = args.transfer
  const id = 'pay_' + randomBytes(9).toString('hex')
  const requestedIntentId = args.intent?.id ?? null
  const requestedToKeyId = args.toKeyId ?? args.intent?.api_key_id ?? null

  return tx(async (q) => {
    // An exact transfer replay is checked first so it remains idempotent even after its intent
    // has become paid. A different transfer must claim an open, unexpired, unused intent.
    let payment = (await q(
      `SELECT id, user_id, intent_id, to_key_id, state FROM payments
        WHERE chain_id = $1 AND lower(tx_hash) = lower($2) AND lower(token) = lower($3) AND received_by = $4
        FOR UPDATE`,
      [t.chain_id, t.tx_hash, t.token, args.receivedAt]
    )).rows[0]
    let duplicate = Boolean(payment)

    if (!payment && requestedIntentId) {
      const intentResult = await q(
        `SELECT id, api_key_id, status, (expires_at > now()) AS not_expired
           FROM payment_intents
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [requestedIntentId, args.userId]
      )
      const intentRow = intentResult.rows[0]
      if (
        !intentRow ||
        intentRow.status !== 'open' ||
        intentRow.not_expired !== true ||
        (intentRow.api_key_id ?? null) !== requestedToKeyId
      ) {
        return {
          paymentId: '', duplicate: true, state: null,
          intentId: requestedIntentId, toKeyId: requestedToKeyId,
          scopeConflict: !intentRow, destinationConflict: Boolean(intentRow && (intentRow.api_key_id ?? null) !== requestedToKeyId),
          ownershipConflict: false, intentConflict: true,
        }
      }

      const existingIntentPayment = await q(
        `SELECT id, user_id, intent_id, to_key_id, state
           FROM payments
          WHERE intent_id = $1
          FOR UPDATE`,
        [requestedIntentId]
      )
      if (existingIntentPayment.rows[0]) {
        return {
          paymentId: existingIntentPayment.rows[0].id, duplicate: true,
          state: existingIntentPayment.rows[0].state ?? null,
          intentId: existingIntentPayment.rows[0].intent_id ?? null,
          toKeyId: existingIntentPayment.rows[0].to_key_id ?? null,
          scopeConflict: false, destinationConflict: false,
          ownershipConflict: existingIntentPayment.rows[0].user_id !== args.userId,
          intentConflict: true,
        }
      }
    }

    if (!payment) {
      const inserted = await q(
        `INSERT INTO payments (id, intent_id, to_key_id, user_id, chain_id, token, tx_hash, received_by, sender,
                               raw_amount, decimals, usd_value_micros, price_usd, pool, purpose, memo, status, refusal_code,
                               state, confirmations, observed_block)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT DO NOTHING
         RETURNING id, user_id, intent_id, to_key_id, state`,
        [id, requestedIntentId, requestedToKeyId, args.userId, t.chain_id, t.token, t.tx_hash ?? null, args.receivedAt,
         t.from, t.raw_amount, t.decimals, args.usdMicros, args.priceUsd ?? null, args.pool ?? null,
         args.intent?.purpose ?? null, args.intent?.memo ?? null, args.status, args.refusalCode,
         args.state ?? (args.status === 'recorded' ? 'confirmed' : 'detected'),
         args.confirmations ?? null, args.observedBlock ?? t.block_number ?? null]
      )
      payment = inserted.rows[0]
      duplicate = !payment
      if (!payment) {
        payment = (await q(
          `SELECT id, user_id, intent_id, to_key_id, state FROM payments
            WHERE chain_id = $1 AND lower(tx_hash) = lower($2) AND lower(token) = lower($3) AND received_by = $4
            FOR UPDATE`,
          [t.chain_id, t.tx_hash, t.token, args.receivedAt]
        )).rows[0]
        if (!payment && requestedIntentId) {
          const existingIntentPayment = (await q(
            `SELECT id, user_id, intent_id, to_key_id, state FROM payments WHERE intent_id = $1 FOR UPDATE`,
            [requestedIntentId]
          )).rows[0]
          if (existingIntentPayment) {
            return {
              paymentId: existingIntentPayment.id, duplicate: true,
              state: existingIntentPayment.state ?? null,
              intentId: existingIntentPayment.intent_id ?? null,
              toKeyId: existingIntentPayment.to_key_id ?? null,
              scopeConflict: false, destinationConflict: false,
              ownershipConflict: existingIntentPayment.user_id !== args.userId,
              intentConflict: true,
            }
          }
        }
      }
    }

    if (!payment?.id) throw new Error('Payment claim insert or replay lookup did not return a payment row')

    const intentId = payment.intent_id ?? null
    const toKeyId = payment.to_key_id ?? null
    const scopeConflict = intentId !== requestedIntentId
    const destinationConflict = toKeyId !== requestedToKeyId
    const ownershipConflict = payment.user_id !== args.userId

    if (!scopeConflict && !destinationConflict && !ownershipConflict && args.status === 'pending_confirmations') {
      const existingEvent = await q(
        `SELECT id FROM payment_events WHERE payment_id = $1 AND kind = 'confirming' LIMIT 1`,
        [payment.id]
      )
      if (!existingEvent.rows[0]) {
        await q(
          `INSERT INTO payment_events (id, payment_id, kind, detail)
           VALUES ($1, $2, 'confirming', $3)`,
          [
            'pev_' + randomBytes(9).toString('hex'),
            payment.id,
            JSON.stringify({
              confirmations: args.confirmations ?? null,
              required: args.requiredConfirmations ?? null,
              observed_block: args.observedBlock == null ? null : String(args.observedBlock),
            }),
          ]
        )
      }
    }

    return {
      paymentId: payment.id,
      duplicate,
      state: payment.state ?? args.state ?? null,
      intentId,
      toKeyId,
      scopeConflict,
      destinationConflict,
      ownershipConflict,
      intentConflict: false,
    }
  })
}

export type CreditsRouteDependencies = {
  findIncomingTransfer?: typeof findIncomingTransfer
  verifyDeposit?: typeof verifyDeposit
}

export function registerCreditsRoutes(app: SessionApp, dependencies: CreditsRouteDependencies = {}): void {
  const findTransfer = dependencies.findIncomingTransfer ?? findIncomingTransfer
  const verifyPayment = dependencies.verifyDeposit ?? verifyDeposit
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
    const agent_receiver = env.platformAgentReceiver || ''
    const automation_receiver = env.platformAutomationReceiver || ''
    const sponsor_receiver = env.platformSponsorReceiver || ''
    const receivers = platformReceivers()
    return c.json({
      receiver_address,
      agent_receiver,
      automation_receiver,
      sponsor_receiver,
      // What users should actually send to. The sponsored wallet when configured, else the vault.
      deposit_address: depositAddress(),
      configured: receivers.length > 0,
      receivers,
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
        receivers: platformReceivers(),
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
    const receivers = platformReceivers()
    const found = await findTransfer({ chainId, txHash, receivers })
    if (!found.ok) {
      // A transfer we already recorded that is no longer on the chain is a reorg, not a bad claim.
      // It is marked and audited rather than ignored, and a credited one is flagged because its
      // ledger entry now has no backing transfer and reversing it is a human decision.
      if (found.code === 'reorg_confirmed') {
        // Only an absence the chain actually confirmed reaches here: findIncomingTransfer now
        // reports an RPC outage as `rpc_error`, which falls through to the 422 below, so one
        // flaky read can no longer mark a real deposit reorged.
        // Every row this transaction describes is reclassified, not an arbitrary one: the same
        // transaction can have paid two of our wallets, and leaving the other row creditable would
        // silently keep a deposit whose transfer no longer exists.
        const reorged = await markReorged(chainId, txHash)
        if (reorged) {
          return c.json(
            {
              accepted: false,
              reconciliation: true,
              needs_reconciliation: reorged.wasCredited,
              payment_id: reorged.paymentId,
              payments: reorged.payments,
              verification: {
                ok: false,
                code: 'reorg_detected',
                message: reorged.wasCredited
                  ? 'This transaction was credited and is no longer on the chain. The payment is flagged for reconciliation; the ledger entry is kept until it is reviewed.'
                  : 'This transaction is no longer on the chain, so the deposit was reversed. The payment is marked reorged and nothing is credited.',
              },
            },
            409
          )
        }
      }
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
    // Finality gate. Recorded now, credited only after the configured depth is met. A later reorg
    // is marked only when independent canonical evidence exists; a missing receipt alone is retryable
    // and never triggers an automatic ledger reversal.
    const finality = found.finality
    const receivedAtOf = (transfer: IncomingTransfer) =>
      transfer.to === String(env.platformReceiverAddress || '').toLowerCase()
        ? 'treasury_vault'
        : transfer.to === String(env.platformAutomationReceiver || '').toLowerCase()
          ? 'automation_account'
          : transfer.to === String(env.platformSponsorReceiver || '').toLowerCase()
            ? 'sponsored_wallet'
            : 'agent_wallet'
    if (finality.state === 'confirming') {
      const waiting = await recordPayment({
        intent, userId: c.get('user')!.id, transfer: t, receivedAt: receivedAtOf(t),
        usdMicros: 0, status: 'pending_confirmations', refusalCode: null,
        state: 'confirming', confirmations: finality.confirmations, requiredConfirmations: finality.required, observedBlock: finality.observedBlock,
      })
      const claimConflict = claimConflictResponse(c, waiting); if (claimConflict) return claimConflict
      return c.json(
        {
          accepted: true,
          credited: false,
          credit_status: 'confirming',
          payment_id: waiting.paymentId,
          duplicate: waiting.duplicate,
          confirmations: finality.confirmations,
          required_confirmations: finality.required,
          received_at: receivedAtOf(t),
          intent: memoOf(intent),
          message: `Waiting for ${finality.required} confirmations (${finality.confirmations} so far). Nothing is credited until then; sending this same request again completes the claim.`,
        },
        202
      )
    }

    // Platform token: valued by the published policy rate, never by the curve we run.
    // It also has no tradable market to convert against, so the auto-convert analysis is
    // skipped on purpose rather than refused.
    if (isPolicyPricedToken(t.token)) {
      const usdMicros = platformTokenUsdMicros(BigInt(t.raw_amount), t.decimals)
      const received_at = t.to === String(env.platformReceiverAddress || '').toLowerCase()
        ? 'treasury_vault'
        : t.to === String(env.platformAutomationReceiver || '').toLowerCase()
          ? 'automation_account'
          : t.to === String(env.platformSponsorReceiver || '').toLowerCase()
            ? 'sponsored_wallet'
            : 'agent_wallet'
      if (usdMicros == null) {
        const refused = await recordPayment({
          intent, userId: c.get('user')!.id, transfer: t, receivedAt: received_at,
          usdMicros: 0, status: 'refused', refusalCode: 'price_unavailable',
          // A refusal is a decision, not a pending state. Storing it as 'detected' left the row
          // inside the credit gate, so a later retry could credit a deposit we had refused.
          state: 'rejected',
        })
        const claimConflict = claimConflictResponse(c, refused); if (claimConflict) return claimConflict
        return c.json({
          accepted: false,
          received_at,
          verification: { ok: true, ...t },
          intent: memoOf(intent),
          payment_id: refused.paymentId,
          refusal: {
            code: 'price_unavailable',
            message: 'No platform-token rate is published, so this deposit cannot be valued. Nothing was credited.',
          },
        }, 422)
      }
      const policyChain = chainSlugFor(chainId)
      const policyDecision = decideCredit({
        chainSlug: policyChain ?? '',
        token: t.token,
        oracleMicros: usdMicros,
        policyPriced: true,
      })
      const policyRecord = await recordPayment({
        intent, userId: c.get('user')!.id, transfer: t, receivedAt: received_at,
        usdMicros, status: policyDecision.status === 'credited' ? 'recorded' : 'pending_conversion',
        refusalCode: policyDecision.status === 'credited' ? null : policyDecision.status,
      })
      const claimConflict = claimConflictResponse(c, policyRecord); if (claimConflict) return claimConflict
      // The stored row decides, on a first claim as much as on a retry. Reading the state we just
      // wrote, keyed by the whole uniqueness key, removes the branch that assumed a fresh claim
      // was 'confirmed' and lets a refused or reorged row speak for itself.
      const policyRef = { chain_id: t.chain_id, tx_hash: t.tx_hash, token: t.token, received_by: received_at }
      let policyCredited = false
      let policyReconciliation = false
      const policySettle = decideSettlement({
        state: await paymentStateFor(policyRef),
        confirmations: finality.confirmations,
        required: finality.required,
      })
      if (policyChain && policyDecision.status === 'credited' && (policySettle.action === 'credit' || policySettle.action === 'already_credited')) {
        const dep = await creditVerified(c.get('user')!.id, usdMicros, { chain: policyChain, txHash: t.tx_hash, token: t.token }, policyRecord.intentId, policyRecord.toKeyId, policyRecord.paymentId, finality, received_at)
        if (dep.destinationConflict || dep.scopeConflict || dep.ownershipConflict || !dep.settled) {
          return c.json({
            accepted: false,
            reconciliation: dep.reconciliation,
            error: {
              code: dep.destinationConflict ? 'deposit_destination_conflict' : dep.scopeConflict ? 'deposit_payment_scope_conflict' : dep.ownershipConflict ? 'deposit_already_owned' : dep.reason ?? 'payment_not_settled',
              message: 'The payment could not be safely settled to the requested destination. No new credit was issued.',
            },
          }, 409)
        }
        policyCredited = Boolean(dep.credited)
        policyReconciliation = Boolean(dep.reconciliation)
      }
      return c.json({
        accepted: true,
        received_at,
        verification: { ok: true, ...t },
        intent: memoOf(intent),
        payment_id: policyRecord.paymentId,
        credited: policyCredited,
        reconciliation: policyReconciliation,
        credit_status: policyDecision.status,
        credit_reason: policyDecision.reason,
        oracle_usd: usdMicros / 1_000_000,
      })
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
          : t.to === String(env.platformSponsorReceiver || '').toLowerCase()
            ? 'sponsored_wallet'
            : 'agent_wallet'
    if (!prepared.ok) {
      const refused = await recordPayment({
        intent, userId: c.get('user')!.id, transfer: t, receivedAt: received_at,
        usdMicros: 0, status: 'refused', refusalCode: prepared.code,
        state: 'rejected',
      })
      const claimConflict = claimConflictResponse(c, refused); if (claimConflict) return claimConflict
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
      // How deep the transfer was when we decided, kept rather than discarded: a later question
      // about a credit ("was it final?") is answered from the row, not re-derived from a chain that
      // has moved on.
      confirmations: finality.confirmations, requiredConfirmations: finality.required, observedBlock: finality.observedBlock,
    })
    const claimConflict = claimConflictResponse(c, recorded); if (claimConflict) return claimConflict

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
    const settleRef = { chain_id: t.chain_id, tx_hash: t.tx_hash, token: t.token, received_by: received_at }
    let reconciliation = false
    const settle = decideSettlement({
      state: await paymentStateFor(settleRef),
      confirmations: finality.confirmations,
      required: finality.required,
    })
    if (chainSlug && (settle.action === 'credit' || settle.action === 'already_credited')) {
      const dep = await creditVerified(c.get('user')!.id, usdMicros, { chain: chainSlug, txHash: t.tx_hash, token: t.token }, recorded.intentId, recorded.toKeyId, recorded.paymentId, finality, received_at)
      if (dep.destinationConflict || dep.scopeConflict || dep.ownershipConflict || !dep.settled) {
        return c.json({
          accepted: false,
          reconciliation: dep.reconciliation,
          error: {
            code: dep.destinationConflict ? 'deposit_destination_conflict' : dep.scopeConflict ? 'deposit_payment_scope_conflict' : dep.ownershipConflict ? 'deposit_already_owned' : dep.reason ?? 'payment_not_settled',
            message: 'The payment could not be safely settled to the requested destination. No new credit was issued.',
          },
        }, 409)
      }
      credited = Boolean(dep.credited)
      reconciliation = Boolean(dep.reconciliation)
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
      reconciliation,
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
  // Compatibility entry point. It now uses the same payment record and atomic settlement
  // transaction as /api/credits/payment-review rather than bypassing the payment audit state.
  app.post('/api/credits/deposit', requireUser, async (c) => {
    const receivers = platformReceivers()
    if (receivers.length === 0) {
      return c.json({ error: { message: 'Platform receiver wallet not configured', type: 'billing' } }, 503)
    }

    const user = c.get('user')!
    const body = await c.req.json().catch(() => ({} as any))
    const chainInput = String(body?.chain ?? '')
    const chainConfig = CHAINS.find((chain) => chain.id === chainInput || String(chain.chainId) === chainInput)
    const txHash = String(body?.tx_hash ?? body?.txHash ?? '')
    if (!chainConfig) {
      return c.json({ error: { message: 'Unsupported chain', type: 'not_found', code: 'not_found' } }, 404)
    }
    if (!txHash) {
      return c.json({ error: { message: 'tx_hash is required', type: 'validation', code: 'invalid_request' } }, 400)
    }

    const found = await findTransfer({ chainId: chainConfig.chainId, txHash, receivers })
    if (!found.ok) {
      return c.json({ error: { message: found.message, type: 'billing', code: found.code } }, found.code === 'invalid_tx_hash' ? 400 : 422)
    }
    const transfer = found.transfer
    const ownership = checkSenderOwnership({ sender: transfer.from, sessionWallet: user.wallet })
    if (!ownership.ok) {
      return c.json({ error: { message: ownership.message, type: 'billing', code: ownership.code } }, 403)
    }

    const receivedAt = transfer.to === String(env.platformReceiverAddress || '').toLowerCase()
      ? 'treasury_vault'
      : transfer.to === String(env.platformAutomationReceiver || '').toLowerCase()
        ? 'automation_account'
        : transfer.to === String(env.platformSponsorReceiver || '').toLowerCase()
          ? 'sponsored_wallet'
          : 'agent_wallet'

    const targetKeyId = body?.api_key_id ? String(body.api_key_id) : null
    if (targetKeyId) {
      const owned = await one(
        'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [targetKeyId, user.id]
      )
      if (!owned) return c.json({ error: { message: 'api_key_id must be one of your active keys', type: 'validation' } }, 400)
    }

    if (found.finality.state === 'confirming') {
      const waiting = await recordPayment({
        intent: null,
        userId: user.id,
        transfer,
        receivedAt,
        usdMicros: 0,
        status: 'pending_confirmations',
        refusalCode: null,
        state: 'confirming',
        confirmations: found.finality.confirmations,
        requiredConfirmations: found.finality.required,
        observedBlock: found.finality.observedBlock,
      })
      const claimConflict = claimConflictResponse(c, waiting); if (claimConflict) return claimConflict
      return c.json({
        accepted: true,
        credited: false,
        credit_status: 'confirming',
        payment_id: waiting.paymentId,
        duplicate: waiting.duplicate,
        confirmations: found.finality.confirmations,
        required_confirmations: found.finality.required,
        received_at: receivedAt,
      }, 202)
    }

    const verification = await verifyPayment({
      chain: chainConfig.id,
      txHash,
      fromWallet: user.wallet,
      selectedTransfer: transfer,
      selectedFinality: found.finality,
    })
    if (!verification.ok) {
      return c.json({ error: { message: verification.message, type: 'billing', code: verification.code } }, 422)
    }

    const decision = decideCredit({
      chainSlug: chainConfig.id,
      token: verification.token,
      oracleMicros: verification.amount_usd_micros,
      policyPriced: isPolicyPricedToken(verification.token),
    })
    const status = decision.status === 'credited'
      ? 'recorded'
      : decision.status === 'pending_conversion'
        ? 'pending_conversion'
        : 'refused'
    const state = decision.status === 'credited'
      ? 'confirmed'
      : decision.status === 'pending_conversion'
        ? 'confirmed'
        : 'rejected'
    const payment = await recordPayment({
      intent: null,
      userId: user.id,
      transfer,
      receivedAt,
      usdMicros: verification.amount_usd_micros,
      status,
      refusalCode: decision.status === 'credited' ? null : decision.reason,
      state,
      confirmations: found.finality.confirmations,
      observedBlock: found.finality.observedBlock,
      priceUsd: verification.price_usd ?? null,
      toKeyId: targetKeyId,
    })
    const claimConflict = claimConflictResponse(c, payment); if (claimConflict) return claimConflict

    if (decision.status !== 'credited') {
      return c.json({
        accepted: true,
        credited: false,
        payment_id: payment.paymentId,
        duplicate: payment.duplicate,
        credit_status: decision.status,
        credit_reason: decision.reason,
        oracle_usd: verification.amount_usd_micros / 1_000_000,
        next_step: decision.status === 'pending_conversion'
          ? 'This token must be converted before spendable credit can be issued. Retry after settlement or use the payment-review flow.'
          : 'The received token valued at zero, so nothing was credited.',
      }, decision.status === 'pending_conversion' ? 202 : 422)
    }

    const settled = await creditPaymentDeposit(
      payment.paymentId,
      user.id,
      verification.amount_usd_micros,
      { chain: chainConfig.id, txHash, token: verification.token },
      {
        toKeyId: payment.toKeyId,
        intentId: payment.intentId,
        receivedBy: receivedAt,
        confirmations: found.finality.confirmations,
        requiredConfirmations: found.finality.required,
      }
    )
    if (settled.destinationConflict || settled.scopeConflict || settled.ownershipConflict || !settled.settled) {
      return c.json({
        accepted: false,
        reconciliation: settled.reconciliation,
        error: {
          code: settled.destinationConflict ? 'deposit_destination_conflict'
            : settled.scopeConflict ? 'deposit_payment_scope_conflict'
              : settled.ownershipConflict ? 'deposit_already_owned'
                : settled.reason ?? 'payment_not_settled',
          message: 'The payment could not be safely settled to the requested destination. No new credit was issued.',
        },
      }, 409)
    }

    return c.json({
      accepted: true,
      credited: settled.credited,
      payment_id: payment.paymentId,
      duplicate: payment.duplicate,
      loaded_to: payment.toKeyId ? 'key' : 'account',
      api_key_id: payment.toKeyId,
      key_credit_usd_micros: settled.keyCredit ?? null,
      balance_usd_micros: settled.balance,
      oracle_usd: verification.amount_usd_micros / 1_000_000,
    })
  })

}
