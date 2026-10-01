import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { env } from '../lib/env.js'
import { query } from '../db/index.js'
import { getBalanceMicros, creditDeposit } from '../lib/billing.js'
import { CHAINS } from '../payments/chains.js'
import { verifyDeposit } from '../payments/verify.js'

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
    return c.json({
      receiver_address,
      configured,
      chains: CHAINS,
    })
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
