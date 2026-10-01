import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { SignJWT, jwtVerify } from 'jose'
import type { Context, Next } from 'hono'
import type { AppEnv, UserRow } from './types.js'
import { env } from './env.js'

const secret = () => new TextEncoder().encode(env.sessionSecret)
export const SESSION_COOKIE = 'haku_session'

export async function createSessionToken(user: UserRow): Promise<string> {
  return new SignJWT({ uid: user.id, wallet: user.wallet, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

export async function readSession(c: Context<AppEnv>): Promise<UserRow | null> {
  const raw = getCookie(c, SESSION_COOKIE) ?? c.req.header('x-session-token') ?? ''
  if (!raw) return null
  try {
    const { payload } = await jwtVerify(raw, secret())
    return {
      id: payload.uid as string,
      wallet: payload.wallet as string,
      role: (payload.role as string) ?? 'user',
      created_at: '',
    }
  } catch {
    return null
  }
}

/** Middleware: require a signed-in (wallet-registered) user. */
export async function requireUser(c: Context<AppEnv>, next: Next) {
  const user = await readSession(c)
  if (!user) return c.json({ error: { message: 'Not authenticated. Connect a wallet first.', type: 'auth', code: 401 } }, 401)
  c.set('user', user)
  await next()
}

/** Attach session user if present (no 401). */
export async function attachUser(c: Context<AppEnv>, next: Next) {
  const user = await readSession(c)
  if (user) c.set('user', user)
  await next()
}

export function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: env.nodeEnv === 'production' || env.isServerless,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
}

export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** Hono app-type helper used by route modules. */
export type SessionApp = Hono<AppEnv>
