import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { verifyMessage } from 'viem'
import { SiweMessage } from 'siwe'
import { decideSiwe } from '../lib/security.js'
import { query, one, dbMode } from '../db/index.js'
import { env, newId } from '../lib/env.js'
import { createSessionToken, setSessionCookie, clearSessionCookie, attachUser, requireUser } from '../lib/session.js'
import { adjustCredit } from '../lib/billing.js'

/** Welcome credit for brand-new accounts. Brokered models run on free-tier provider
 *  keys, so honoring ~$0.02 of usage costs the platform nothing while making the
 *  first agent run work out of the box. */
const SIGNUP_BONUS_MICROS = 20_000
import type { AppEnv } from '../lib/types.js'


/**
 * Redacted diagnostics for a failed SIWE parse (SEC-004).
 *
 * The raw message used to be logged. It carries the wallet address, the nonce, the domain and
 * the URI, so a log reader could replay a still-valid nonce or correlate a user's address across
 * failures. Everything here describes the message structurally instead: enough to tell a CRLF
 * problem from a missing field, nothing that identifies or authorises anyone.
 */
export function describeSiweParseFailure(
  message: string,
  err?: unknown
): { code: string; length: number; has_address: boolean; has_nonce: boolean; has_crlf: boolean; parser_error: string } {
  const errName = err instanceof Error ? err.name : typeof err
  // The parser's own message can quote the input, so keep only a classified shape of it.
  const errShape = String((err as any)?.message ?? '')
    .toLowerCase()
    .includes('nonce')
    ? 'nonce_unparseable'
    : String((err as any)?.message ?? '')
        .toLowerCase()
        .includes('expiration')
      ? 'expiration_unparseable'
      : 'format_unparseable'
  return {
    code: 'siwe_parse_failed',
    length: typeof message === 'string' ? message.length : 0,
    has_address: /0x[a-fA-F0-9]{40}/.test(message || ''),
    has_nonce: /Nonce:\s*[A-Za-z0-9_-]+/i.test(message || ''),
    has_crlf: /\r\n/.test(message || ''),
    parser_error: `${errName}:${errShape}`,
  }
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  // GET /api/auth/nonce
  app.get('/api/auth/nonce', async (c) => {
    const nonce = randomBytes(16).toString('hex') // 32 hex chars
    await query('INSERT INTO auth_nonces (nonce) VALUES ($1)', [nonce])
    return c.json({ nonce })
  })

  // POST /api/auth/verify
  app.post('/api/auth/verify', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const { message, signature } = body

    if (!message || typeof message !== 'string' || !signature || typeof signature !== 'string') {
      return c.json(
        { error: { message: 'Missing message or signature.', type: 'invalid_request', code: 400 } },
        400
      )
    }

    let siweMsg: SiweMessage
    let lenient = false
    try {
      siweMsg = new SiweMessage(message)
    } catch (e: any) {
      // Some mobile wallets (WalletConnect relays, in-app browsers) mangle the message
      // (CRLF line endings, trimmed/reordered fields) so the strict EIP-4361 parser throws.
      // Security is preserved: nonce is single-use, freshness enforced via the nonce row's
      // created_at, and the signature is verified against the EXACT raw message below.
      const addr = message.match(/0x[a-fA-F0-9]{40}/)?.[0]
      const nonce = message.match(/Nonce:\s*([A-Za-z0-9_-]+)/i)?.[1]
      if (!addr || !nonce) {
        console.warn('[auth] SIWE parse failed', describeSiweParseFailure(message, e))
        return c.json(
          { error: { message: 'Invalid SIWE message format.', type: 'invalid_request', code: 400 } },
          400
        )
      }
      lenient = true
      siweMsg = { address: addr, nonce, issuedAt: '' } as unknown as SiweMessage
      console.warn('[auth] SIWE strict parse failed, using lenient parse', describeSiweParseFailure(message, e))
    }

    // Single-use nonce check
    const nonceRow = await one('SELECT nonce, created_at FROM auth_nonces WHERE nonce = $1', [siweMsg.nonce])
    if (!nonceRow) {
      return c.json(
        { error: { message: 'Invalid or expired nonce.', type: 'invalid_request', code: 400 } },
        400
      )
    }
    await query('DELETE FROM auth_nonces WHERE nonce = $1', [siweMsg.nonce])

    // Expiration/Issued-At check (issued < 10 minutes ago)
    if (!lenient && siweMsg.issuedAt) {
      const issuedAtTime = new Date(siweMsg.issuedAt).getTime()
      if (isNaN(issuedAtTime) || Date.now() - issuedAtTime > 10 * 60 * 1000) {
        return c.json(
          { error: { message: 'SIWE message expired (issued > 10 minutes ago).', type: 'invalid_request', code: 400 } },
          400
        )
      }
    }
    if (lenient && nonceRow) {
      const nonceAge = Date.now() - new Date(nonceRow.created_at).getTime()
      if (nonceAge > 10 * 60 * 1000) {
        return c.json(
          { error: { message: 'Sign-in request expired, please try again.', type: 'invalid_request', code: 400 } },
          400
        )
      }
    }

    // Domain mismatch check (rejecting, not merely logging)
    const host = c.req.header('host')
    const decision = decideSiwe({
      messageDomain: siweMsg.domain,
      host,
      strictParseFailed: lenient,
      nodeEnv: env.nodeEnv,
      allowLenient: process.env.ALLOW_LENIENT_SIWE === '1',
      allowDomainMismatch: process.env.ALLOW_SIWE_DOMAIN_MISMATCH === '1',
    })
    if (!decision.ok) {
      console.warn(`[auth] SIWE rejected: ${decision.reason}; domain="${siweMsg.domain ?? ''}", host="${host ?? ''}"`)
      return c.json({ error: { message: 'Signature does not match this site or message format.', type: 'auth', code: 401 } }, 401)
    }

    // Signature verification using viem
    let isValid = false
    try {
      isValid = await verifyMessage({
        address: siweMsg.address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      })
    } catch (e: any) {
      isValid = false
    }

    if (!isValid) {
      return c.json(
        { error: { message: 'Signature verification failed.', type: 'auth', code: 400 } },
        400
      )
    }

    // Upsert user by lowercase wallet address
    const wallet = siweMsg.address.toLowerCase()
    let user = await one('SELECT id, wallet, role FROM users WHERE wallet = $1', [wallet])
    if (!user) {
      const userId = newId()
      user = await one(
        'INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) RETURNING id, wallet, role',
        [userId, wallet, 'user']
      )
      if (SIGNUP_BONUS_MICROS > 0) {
        try {
          await adjustCredit(userId, SIGNUP_BONUS_MICROS, 'signup-bonus')
        } catch (e) {
          console.warn('[auth] signup bonus failed:', (e as Error).message)
        }
      }
    }

    // Create session token and set cookie
    const token = await createSessionToken(user)
    setSessionCookie(c, token)

    return c.json({
      user: {
        id: user.id,
        wallet: user.wallet,
        role: user.role,
      },
    })
  })

  // POST /api/auth/logout
  app.post('/api/auth/logout', async (c) => {
    clearSessionCookie(c)
    return c.json({ ok: true })
  })

  // GET /api/me
  app.get('/api/me', attachUser, async (c) => {
    const user = c.get('user') ?? null
    const prefs = user
      ? await one('SELECT pay_in_token FROM users WHERE id = $1', [user.id])
      : null
    return c.json({
      user: user
        ? {
            id: user.id,
            wallet: user.wallet,
            role: user.role,
            pay_in_token: Boolean(prefs?.pay_in_token),
          }
        : null,
      platform_token: env.platformTokenAddress
        ? { symbol: env.platformTokenSymbol, address: env.platformTokenAddress, live: true }
        : null,
      mode: dbMode(),
    })
  })

  // PATCH /api/me/preferences — currently: settle-in-token preference
  app.patch('/api/me/preferences', requireUser, async (c) => {
    const user = c.get('user')!
    const body = await c.req.json().catch(() => ({} as any))
    if (typeof body?.pay_in_token !== 'boolean') {
      return c.json(
        { error: { message: 'pay_in_token must be a boolean.', type: 'invalid_request', code: 400 } },
        400
      )
    }
    const updated = await one(
      'UPDATE users SET pay_in_token = $1 WHERE id = $2 RETURNING pay_in_token',
      [body.pay_in_token, user.id]
    )
    return c.json({ ok: true, pay_in_token: Boolean(updated?.pay_in_token) })
  })

  // GET /api/healthz
  app.get('/api/healthz', (c) => {
    return c.json({
      ok: true,
      mode: dbMode(),
      time: new Date().toISOString(),
    })
  })
}
