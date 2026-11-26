import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { verifyMessage } from 'viem'
import { SiweMessage } from 'siwe'
import {
  decideSiwe,
  normalizeSiweText,
  extractSiweDomain,
  normalizeHost,
} from '../lib/security.js'
import { query, one, dbMode } from '../db/index.js'
import { env, newId, sha256 } from '../lib/env.js'
import { checkBucketLimit } from '../lib/ratelimit.js'
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


/**
 * Auth abuse protection (SEC-006).
 *
 * `/api/auth/nonce` and `/api/auth/verify` are unauthenticated by definition, so they are limited
 * per client rather than per key. The client identity is hashed: the counters table never holds a
 * raw IP. Limits are deliberately generous enough for a normal retry loop and tight enough that a
 * flood costs the attacker more than it costs us.
 */
export const AUTH_NONCE_RPM = 20
export const AUTH_VERIFY_RPM = 10
/** Public feedback intake: generous for a person, hostile to a script. */
export const FEEDBACK_RPM = 6
/** A nonce older than this cannot be used, so it should not be kept either. */
export const NONCE_TTL_MINUTES = 15

export function clientBucket(kind: 'nonce' | 'verify' | 'feedback' | 'agent_register', c: any): string {
  const fwd = String(c?.req?.header?.('x-forwarded-for') || '').split(',')[0].trim()
  const ip = fwd || String(c?.req?.header?.('cf-connecting-ip') || '') || String(c?.req?.header?.('x-real-ip') || '') || 'unknown'
  return `auth:${kind}:${sha256(ip).slice(0, 24)}`
}

/** Best-effort sweep so issued-but-unused nonces cannot accumulate forever. */
/** Diagnostics older than this are deleted: the table answers "what happened lately", it is not an archive. */
export const SIGNIN_LOG_RETENTION_DAYS = 30

export async function pruneExpiredNonces(): Promise<void> {
  await query(`DELETE FROM auth_nonces WHERE created_at < now() - ($1 || ' minutes')::interval`, [String(NONCE_TTL_MINUTES)])
  // Same sweep keeps auth_signin_log bounded, so it cannot grow forever on a public endpoint.
  await query(`DELETE FROM auth_signin_log WHERE created_at < now() - ($1 || ' days')::interval`, [String(SIGNIN_LOG_RETENTION_DAYS)])
}

/**
 * Every hostname this request could legitimately be for, most trustworthy first.
 *
 * The Host header comes from the URL a browser cannot choose, so it is the anchor. X-Forwarded-Host
 * can be set by any same-origin fetch, so honouring it unconditionally would let a caller pick its
 * own allowed domain for the nonce and then again for the verify. It is honoured only when it
 * agrees with Host or when the operator has pinned that domain in SIWE_ALLOWED_DOMAINS.
 */
export function requestHosts(c: any): string[] {
  const host = normalizeHost(c?.req?.header?.('host'))
  const forwarded = normalizeHost(c?.req?.header?.('x-forwarded-host'))
  const pinned = String(process.env.SIWE_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((entry) => normalizeHost(entry))
    .filter((entry): entry is string => Boolean(entry))
  const out: string[] = []
  if (host) out.push(host)
  if (forwarded && (forwarded === host || pinned.includes(forwarded)) && !out.includes(forwarded)) {
    out.push(forwarded)
  }
  for (const domain of pinned) if (!out.includes(domain)) out.push(domain)
  return out
}

/**
 * Record a sign-in that needed the tolerant path, or that was refused.
 *
 * Vercel runtime logs are not retained long enough to answer "why did this user's sign-in fail",
 * which is exactly the question that took a support round trip to ask. This row answers it, and it
 * deliberately holds no nonce, no address and no signature: only the reason, the domain the message
 * claimed, and the host the request arrived on.
 */
export async function recordSignInDiagnostic(row: {
  outcome: 'accepted' | 'rejected'
  reason: string
  messageDomain: string | null
  requestHost: string | null
  lenient: boolean
}): Promise<void> {
  await query(
    `INSERT INTO auth_signin_log (outcome, reason, message_domain, request_host, lenient) VALUES ($1, $2, $3, $4, $5)`,
    [row.outcome, row.reason.slice(0, 120), row.messageDomain?.slice(0, 120) ?? null, row.requestHost?.slice(0, 120) ?? null, row.lenient]
  ).catch((e) => {
    // Diagnostics must never be the reason a valid login fails, but a silent swallow here would
    // hide the very failures this table exists to explain.
    console.warn('[auth] sign-in diagnostic not recorded:', (e as Error).message)
  })
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  // GET /api/auth/nonce
  app.get('/api/auth/nonce', async (c) => {
    const limit = await checkBucketLimit(clientBucket('nonce', c), AUTH_NONCE_RPM)
    if (!limit.ok) {
      c.header('retry-after', String(limit.reset_seconds))
      return c.json(
        { error: { message: 'Too many nonce requests. Try again shortly.', type: 'rate_limit', code: 429 } },
        429
      )
    }
    const nonce = randomBytes(16).toString('hex') // 32 hex chars
    await query('INSERT INTO auth_nonces (nonce) VALUES ($1)', [nonce])
    // Bounded cleanup: a nonce that was issued and never used must not live forever.
    await pruneExpiredNonces().catch(() => {})
    // Hand the client the domain WE see this request on, so the message it asks the wallet to sign
    // carries that domain rather than whatever window.location reports. A mobile wallet browser or
    // a transcoding proxy can present a different location than the host header of the very same
    // request, and that mismatch is what made mobile sign-in fail as "wrong site".
    return c.json({ nonce, domain: requestHosts(c)[0] ?? null })
  })

  // POST /api/auth/verify
  app.post('/api/auth/verify', async (c) => {
    // Brute force against a live nonce is infeasible, but the endpoint is a cheap way to make us
    // do secp256k1 work and mint session tokens. Limited per client before the body is parsed.
    const verifyLimit = await checkBucketLimit(clientBucket('verify', c), AUTH_VERIFY_RPM)
    if (!verifyLimit.ok) {
      c.header('retry-after', String(verifyLimit.reset_seconds))
      return c.json(
        { error: { message: 'Too many sign-in attempts. Try again shortly.', type: 'rate_limit', code: 429 } },
        429
      )
    }

    const body = await c.req.json().catch(() => ({}))
    const { message, signature } = body

    if (!message || typeof message !== 'string' || !signature || typeof signature !== 'string') {
      return c.json(
        { error: { message: 'Missing message or signature.', type: 'invalid_request', code: 400 } },
        400
      )
    }

    // Normalise the transport noise (CRLF endings, padded whitespace, BOM, zero-width joiners) and
    // parse THAT. The signature is still checked against the exact bytes the wallet signed, so this
    // cannot accept a message the user did not approve; it only stops a message we generated from
    // being rejected because a mobile wallet or a data-saving browser re-serialised its newlines.
    const normalized = normalizeSiweText(message)
    let siweMsg: SiweMessage
    let lenient = false
    try {
      siweMsg = new SiweMessage(normalized)
    } catch (e: any) {
      // Still unreadable as EIP-4361. Recover what we can and let decideSiwe decide, now that the
      // domain is recovered too: the old path gave up on the domain, which meant every one of these
      // was refused in production with a message that told the user nothing.
      const addr = normalized.match(/0x[a-fA-F0-9]{40}/)?.[0]
      const nonce = normalized.match(/Nonce:\s*([A-Za-z0-9_-]+)/i)?.[1]
      if (!addr || !nonce) {
        console.warn('[auth] SIWE parse failed', describeSiweParseFailure(normalized, e))
        await recordSignInDiagnostic({
          outcome: 'rejected',
          reason: 'unparseable',
          messageDomain: extractSiweDomain(normalized),
          requestHost: requestHosts(c)[0] ?? null,
          lenient: true,
        })
        return c.json(
          { error: { message: 'Invalid SIWE message format.', type: 'invalid_request', code: 400 } },
          400
        )
      }
      lenient = true
      siweMsg = {
        address: addr,
        nonce,
        issuedAt: '',
        domain: extractSiweDomain(normalized) ?? undefined,
      } as unknown as SiweMessage
      console.warn('[auth] SIWE strict parse failed, using lenient parse', describeSiweParseFailure(normalized, e))
    }

    // Single-use nonce check
    const nonceRow = await one('SELECT nonce, created_at FROM auth_nonces WHERE nonce = $1', [siweMsg.nonce])
    if (!nonceRow) {
      // Not recorded in auth_signin_log: without a valid nonce there is nothing to attribute the row
      // to, and that table is written on a public endpoint. The console line is the record.
      console.warn('[auth] SIWE rejected: unknown_or_used_nonce')
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
        console.warn('[auth] SIWE rejected: stale_nonce')
        return c.json(
          { error: { message: 'Sign-in request expired, please try again.', type: 'invalid_request', code: 400 } },
          400
        )
      }
    }

    // Signature verification, deliberately BEFORE the domain decision and before any diagnostic
    // row is written. The endpoint is public, so a write that precedes proof of a signature would
    // let anyone holding a fresh nonce fill an indexed table with rows of their choosing.
    const address = siweMsg.address as `0x${string}`
    const sig = signature as `0x${string}`
    let isValid = false
    try {
      isValid = await verifyMessage({ address, message, signature: sig })
    } catch (e: any) {
      isValid = false
    }
    // A wallet that re-serialised the message before signing (newline normalisation is the common
    // one) produces a signature over the normalised text. Check it too, but only over text derived
    // from the same message by our own normaliser, so nothing else can be substituted.
    if (!isValid && normalized !== message) {
      try {
        isValid = await verifyMessage({ address, message: normalized, signature: sig })
      } catch (e: any) {
        isValid = false
      }
    }

    // An unproven signature is answered here, before the domain decision, so a caller who cannot
    // sign learns nothing about which hosts we accept and no diagnostic row can be attributed to
    // them. Everything below this line has a real signer behind it.
    if (!isValid) {
      console.warn(`[auth] SIWE rejected: bad_signature; domain="${siweMsg.domain ?? ''}"`)
      return c.json(
        { error: { message: 'Signature verification failed.', type: 'auth', code: 400 } },
        400
      )
    }

    // Domain mismatch check (rejecting, not merely logging). Every hostname this request may
    // legitimately be for is allowed, headers first, plus anything the operator pinned in
    // SIWE_ALLOWED_DOMAINS, so a proxy browser or a custom domain cannot fail us on our own site.
    const hosts = requestHosts(c)
    const decision = decideSiwe({
      messageDomain: siweMsg.domain,
      host: c.req.header('host'),
      allowedHosts: hosts,
      strictParseFailed: lenient,
      nodeEnv: env.nodeEnv,
      allowLenient: process.env.ALLOW_LENIENT_SIWE === '1',
      allowDomainMismatch: process.env.ALLOW_SIWE_DOMAIN_MISMATCH === '1',
    })
    if (!decision.ok) {
      console.warn(`[auth] SIWE rejected: ${decision.reason}; domain="${siweMsg.domain ?? ''}", host="${hosts.join(',')}"`)
      // The row says a real signer was refused, which is the case worth knowing about.
      await recordSignInDiagnostic({
        outcome: 'rejected',
        reason: decision.reason ?? 'rejected',
        messageDomain: siweMsg.domain ?? extractSiweDomain(normalized),
        requestHost: hosts[0] ?? null,
        lenient,
      })
      return c.json(
        {
          error: {
            message: 'Signature does not match this site or message format.',
            type: 'auth',
            code: 401,
            reason: decision.reason,
          },
        },
        401
      )
    }
    if (lenient) {
      // Accepted on the tolerant path: worth a durable row, because it means a wallet or a browser
      // altered our own message and the next user may hit the same thing.
      await recordSignInDiagnostic({
        outcome: 'accepted',
        reason: 'lenient_accepted',
        messageDomain: siweMsg.domain ?? extractSiweDomain(normalized),
        requestHost: hosts[0] ?? null,
        lenient,
      })
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
        ? {
            symbol: env.platformTokenSymbol,
            address: env.platformTokenAddress,
            decimals: env.platformTokenDecimals,
            live: true,
            chain_id: 8453,
            chain: 'base',
            // Priced by the published policy rate, not by the pool we run.
            priced: Number(env.platformTokenUsdRate) > 0,
            usd_rate: Number(env.platformTokenUsdRate) || 0,
            bonus_bps: Number(env.platformTokenBonusBps) || 0,
            max_deposit_usd: Number(env.platformTokenMaxDepositUsd) || 0,
          }
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

  // /api/healthz is registered in src/app.ts, ahead of the database bootstrap, and reports
  // readiness. A second registration here would shadow it or be shadowed by it depending on
  // order, and this one answered ok:true unconditionally.
}
