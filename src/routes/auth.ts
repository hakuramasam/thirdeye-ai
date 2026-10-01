import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { verifyMessage } from 'viem'
import { SiweMessage } from 'siwe'
import { query, one, dbMode } from '../db/index.js'
import { newId } from '../lib/env.js'
import { createSessionToken, setSessionCookie, clearSessionCookie, attachUser } from '../lib/session.js'
import type { AppEnv } from '../lib/types.js'

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
    try {
      siweMsg = new SiweMessage(message)
    } catch (e: any) {
      return c.json(
        { error: { message: 'Invalid SIWE message format.', type: 'invalid_request', code: 400 } },
        400
      )
    }

    // Single-use nonce check
    const nonceRow = await one('SELECT nonce FROM auth_nonces WHERE nonce = $1', [siweMsg.nonce])
    if (!nonceRow) {
      return c.json(
        { error: { message: 'Invalid or expired nonce.', type: 'invalid_request', code: 400 } },
        400
      )
    }
    await query('DELETE FROM auth_nonces WHERE nonce = $1', [siweMsg.nonce])

    // Expiration/Issued-At check (issued < 10 minutes ago)
    if (siweMsg.issuedAt) {
      const issuedAtTime = new Date(siweMsg.issuedAt).getTime()
      if (isNaN(issuedAtTime) || Date.now() - issuedAtTime > 10 * 60 * 1000) {
        return c.json(
          { error: { message: 'SIWE message expired (issued > 10 minutes ago).', type: 'invalid_request', code: 400 } },
          400
        )
      }
    }

    // Domain mismatch check (logging only)
    const host = c.req.header('host')
    if (host && siweMsg.domain && siweMsg.domain !== host) {
      console.warn(`[auth] SIWE domain mismatch: message domain="${siweMsg.domain}", host="${host}"`)
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
    return c.json({
      user: user ? { id: user.id, wallet: user.wallet, role: user.role } : null,
      mode: dbMode(),
    })
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
