import type { Context, Next } from 'hono'
import type { AppEnv, ApiKeyRow, UserRow } from './types.js'
import { sha256, newId } from './env.js'
import { one } from '../db/index.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** Generate a new API key secret: sk-thirdeye-<48 chars> */
export function generateApiKeySecret(): string {
  let s = ''
  const buf = crypto.getRandomValues(new Uint8Array(48))
  for (const b of buf) s += ALPHABET[b % ALPHABET.length]
  return `sk-thirdeye-${s}`
}

export function hashSecret(secret: string): string {
  return sha256(secret)
}

export function keyPrefix(secret: string): string {
  return secret.slice(0, 12) + '...' + secret.slice(-4)
}

export async function createApiKey(userId: string, name: string, rpm: number, tpm: number) {
  const secret = generateApiKeySecret()
  const row = await one(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, rpm, tpm)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [newId(), userId, name, hashSecret(secret), keyPrefix(secret), rpm, tpm]
  )
  return { secret, row }
}

/**
 * Middleware for /api/v1/* OpenAI-compatible endpoints.
 * Bearer sk-thirdeye-... -> resolves user + key row onto the context.
 */
export async function apiKeyAuth(c: Context<AppEnv>, next: Next) {
  const auth = c.req.header('authorization') ?? ''
  const secret = auth.replace(/^Bearer\s+/i, '').trim()
  if (!secret.startsWith('sk-thirdeye-')) {
    return c.json({ error: { message: 'Missing or malformed API key. Expected: Authorization: Bearer sk-thirdeye-...', type: 'auth', code: 401 } }, 401)
  }
  const key = await one(
    `SELECT k.*, u.wallet AS user_wallet, u.role AS user_role FROM api_keys k
     JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [hashSecret(secret)]
  )
  if (!key || key.revoked_at) {
    return c.json({ error: { message: 'Invalid or revoked API key.', type: 'auth', code: 401 } }, 401)
  }
  const apiKey: ApiKeyRow = {
    id: key.id, user_id: key.user_id, name: key.name, key_prefix: key.key_prefix,
    rpm: key.rpm, tpm: key.tpm, revoked_at: key.revoked_at, created_at: key.created_at,
  }
  const user: UserRow = { id: key.user_id, wallet: key.user_wallet, role: key.user_role, created_at: '' }
  c.set('apiKey', apiKey)
  c.set('user', user)
  await next()
}
