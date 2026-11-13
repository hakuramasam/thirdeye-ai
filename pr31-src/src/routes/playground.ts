/**
 * Playground access for the signed-in dashboard.
 *
 * The dashboard has no way to chat with a model without first creating an API key by
 * hand, which is the biggest friction gap against the platforms we compete with.
 * Rather than duplicating the chat path (billing, rate limits, streaming, tools all
 * live in /api/v1), this issues a short-lived, revocable key bound to the session's
 * user and lets the browser call the real endpoint. One chat path, one billing path.
 */
import { Hono } from 'hono'
import { one, query } from '../db/index.js'
import { newId } from '../lib/env.js'
import { generateApiKeySecret, hashSecret, keyPrefix } from '../lib/keys.js'
import { requireUser } from '../lib/session.js'
import type { AppEnv } from '../lib/types.js'

export const PLAYGROUND_KEY_NAME = 'dashboard playground'

export function registerPlaygroundRoutes(app: Hono<AppEnv>): void {
  // Issue (and rotate) the playground key. Previous playground keys are revoked so a
  // leaked token dies on the next page load.
  app.post('/api/playground/token', requireUser, async (c) => {
    const user = c.get('user')!
    await query(
      `UPDATE api_keys SET revoked_at = now()
        WHERE user_id = $1 AND name = $2 AND revoked_at IS NULL`,
      [user.id, PLAYGROUND_KEY_NAME]
    )
    const secret = generateApiKeySecret()
    const id = newId()
    await query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, rpm, tpm)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, user.id, PLAYGROUND_KEY_NAME, hashSecret(secret), keyPrefix(secret), 60, 250000]
    )
    const bal = await one(
      'SELECT COALESCE(SUM(amount_usd_micros), 0)::bigint AS bal FROM ledger WHERE user_id = $1',
      [user.id]
    )
    return c.json({
      token: secret,
      key_id: id,
      expires_with: 'revoked on next dashboard load or explicit revoke',
      balance_usd_micros: Number(bal?.bal ?? 0),
      note: 'Calls go to /api/v1/chat/completions and are billed exactly like a normal key.',
    })
  })
}
