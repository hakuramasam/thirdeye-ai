import { Hono } from 'hono'
import type { SessionApp } from '../lib/session.js'
import { requireUser } from '../lib/session.js'
import { createApiKey } from '../lib/keys.js'
import { encryptSecret, newId } from '../lib/env.js'
import { query, one } from '../db/index.js'

export function registerKeysRoutes(app: SessionApp): void {
  // GET /api/keys
  app.get('/api/keys', requireUser, async (c) => {
    const user = c.get('user')!
    const res = await query(
      `SELECT id, name, key_prefix AS prefix, key_prefix, rpm, tpm, created_at, revoked_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    )
    const keys = res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      key_prefix: r.key_prefix,
      rpm: Number(r.rpm),
      tpm: Number(r.tpm),
      created_at: r.created_at,
      revoked_at: r.revoked_at,
    }))
    return c.json({ keys })
  })

  // POST /api/keys
  app.post('/api/keys', requireUser, async (c) => {
    const user = c.get('user')!
    let body: any
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }

    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name || name.length < 1 || name.length > 64) {
      return c.json(
        {
          error: {
            message: 'Key name is required (1-64 characters).',
            type: 'invalid_request',
            code: 400,
          },
        },
        400
      )
    }

    const rpm = body?.rpm !== undefined ? Number(body.rpm) : 60
    const tpm = body?.tpm !== undefined ? Number(body.tpm) : 250000

    if (isNaN(rpm) || rpm < 1 || rpm > 10000) {
      return c.json(
        {
          error: {
            message: 'RPM must be an integer between 1 and 10,000.',
            type: 'invalid_request',
            code: 400,
          },
        },
        400
      )
    }

    if (isNaN(tpm) || tpm < 1 || tpm > 10000000) {
      return c.json(
        {
          error: {
            message: 'TPM must be an integer between 1 and 10,000,000.',
            type: 'invalid_request',
            code: 400,
          },
        },
        400
      )
    }

    // Check max active keys (max 20)
    const activeCountRow = await one(
      `SELECT COUNT(*)::int AS count FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id]
    )
    const activeCount = Number(activeCountRow?.count ?? 0)
    if (activeCount >= 20) {
      return c.json(
        {
          error: {
            message: 'Maximum 20 active API keys reached.',
            type: 'invalid_request',
            code: 400,
          },
        },
        400
      )
    }

    const { secret, row } = await createApiKey(user.id, name, rpm, tpm)
    const formattedRow = {
      id: row.id,
      name: row.name,
      prefix: row.key_prefix,
      key_prefix: row.key_prefix,
      rpm: Number(row.rpm),
      tpm: Number(row.tpm),
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    }

    return c.json({ secret, row: formattedRow }, 201)
  })

  // DELETE /api/keys/:id (soft-revoke)
  app.delete('/api/keys/:id', requireUser, async (c) => {
    const user = c.get('user')!
    const keyId = c.req.param('id')

    const res = await query(
      `UPDATE api_keys
       SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [keyId, user.id]
    )

    if (res.rowCount === 0) {
      return c.json(
        {
          error: {
            message: 'API key not found or already revoked.',
            type: 'not_found',
            code: 404,
          },
        },
        404
      )
    }

    return c.json({ ok: true })
  })

  // GET /api/keys/byok
  app.get('/api/keys/byok', requireUser, async (c) => {
    const user = c.get('user')!
    const res = await query(
      `SELECT provider, created_at
       FROM byok_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    )
    const providers = res.rows.map((r) => ({
      provider: r.provider,
      created_at: r.created_at,
    }))

    return c.json({ providers })
  })

  // PUT /api/keys/byok
  app.put('/api/keys/byok', requireUser, async (c) => {
    const user = c.get('user')!
    let body: any
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }

    const providerRaw = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : ''
    const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''

    if (!providerRaw || providerRaw.length < 2 || providerRaw.length > 24) {
      return c.json(
        {
          error: {
            message: 'Provider name must be 2-24 characters.',
            type: 'invalid_request',
            code: 400,
          },
        },
        400
      )
    }

    if (!apiKey || apiKey.length < 8 || apiKey.length > 500) {
      return c.json(
        {
          error: {
            message: 'API key must be 8-500 characters.',
            type: 'invalid_request',
            code: 400,
          },
        },
        400
      )
    }

    const ciphertext = encryptSecret(apiKey)
    const id = newId()

    const res = await one(
      `INSERT INTO byok_keys (id, user_id, provider, key_ciphertext)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET key_ciphertext = EXCLUDED.key_ciphertext, created_at = NOW()
       RETURNING provider, created_at`,
      [id, user.id, providerRaw, ciphertext]
    )

    if (!res) {
      return c.json(
        { error: { message: 'Failed to save BYOK key.', type: 'internal', code: 500 } },
        500
      )
    }

    return c.json({
      provider: res.provider,
      created_at: res.created_at,
    })
  })

  // DELETE /api/keys/byok/:provider
  app.delete('/api/keys/byok/:provider', requireUser, async (c) => {
    const user = c.get('user')!
    const providerParam = c.req.param('provider')
    const provider = (providerParam || '').toLowerCase()

    await query(
      `DELETE FROM byok_keys WHERE user_id = $1 AND provider = $2`,
      [user.id, provider]
    )

    return c.json({ ok: true })
  })

  // GET /api/models
  app.get('/api/models', requireUser, async (c) => {
    const res = await query(
      `SELECT model, provider, price_in_1m_usd_micros, price_out_1m_usd_micros
       FROM models_catalog
       WHERE enabled = true
       ORDER BY model ASC`
    )
    const models = res.rows.map((r) => ({
      model: r.model,
      provider: r.provider,
      price_in_1m_usd_micros: Number(r.price_in_1m_usd_micros),
      price_out_1m_usd_micros: Number(r.price_out_1m_usd_micros),
    }))

    return c.json({ models })
  })
}
