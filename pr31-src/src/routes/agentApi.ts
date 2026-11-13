import type { SessionApp } from '../lib/session.js'
import { readSession } from '../lib/session.js'
import { query, one } from '../db/index.js'
import { newId } from '../lib/env.js'
import { checkBucketLimit } from '../lib/ratelimit.js'
import { clientBucket } from './auth.js'
import { createApiKey, hashSecret } from '../lib/keys.js'

/**
 * Agent-facing API.
 *
 * An outside agent can register an identity, receive one key bound to that identity, call inference
 * with it, and appear in a public directory. What it cannot do is hold money: billing is per user
 * account, so an identity bills its owner. Making that explicit here is deliberate, because the
 * alternative (an agent with its own balance) would be a second ledger and a second way to lose
 * track of who owes what.
 */

export const AGENT_REGISTER_PER_HOUR = 5
const NAME_MIN = 2
const NAME_MAX = 60
const DESC_MIN = 20
const DESC_MAX = 600
const MAX_CAPABILITIES = 12
const CAPABILITY_MAX = 40

export type AgentRegistration = {
  name?: unknown
  description?: unknown
  capabilities?: unknown
  homepage?: unknown
  callbackUrl?: unknown
}

export type ValidatedAgent = {
  name: string
  slug: string
  description: string
  capabilities: string[]
  homepage: string | null
  callbackUrl: string | null
}

/** Lowercase, hyphens, no leading or trailing hyphen, bounded, and never empty. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'agent'
}

/** https only, on a host that is not an IP literal and not localhost. No query, no fragment. */
function cleanUrl(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    return { ok: false, message: `${field} must be a complete URL.` }
  }
  if (url.protocol !== 'https:') return { ok: false, message: `${field} must use https.` }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || /^[0-9.]+$/.test(host) || host.endsWith('.local') || !host.includes('.')) {
    return { ok: false, message: `${field} must point at a public hostname, not a local or literal address.` }
  }
  if (url.search || url.hash) return { ok: false, message: `${field} must not carry a query string or fragment.` }
  return { ok: true, value: `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '') }
}

export function validateAgent(input: AgentRegistration): { ok: true; value: ValidatedAgent } | { ok: false; code: string; message: string } {
  const name = String(input.name ?? '').trim()
  if (name.length < NAME_MIN) return { ok: false, code: 'name_too_short', message: `name must be at least ${NAME_MIN} characters.` }
  if (name.length > NAME_MAX) return { ok: false, code: 'name_too_long', message: `name must be under ${NAME_MAX} characters.` }

  const description = String(input.description ?? '').trim()
  if (description.length < DESC_MIN) {
    return { ok: false, code: 'description_too_short', message: `description must be at least ${DESC_MIN} characters, since it is what the directory shows.` }
  }
  if (description.length > DESC_MAX) return { ok: false, code: 'description_too_long', message: `description must be under ${DESC_MAX} characters.` }

  const rawCaps = input.capabilities
  if (rawCaps !== undefined && rawCaps !== null && !Array.isArray(rawCaps)) {
    return { ok: false, code: 'capabilities_not_list', message: 'capabilities must be an array of short strings.' }
  }
  const capabilities: string[] = []
  for (const cap of (rawCaps as unknown[] | undefined) ?? []) {
    const value = String(cap).trim()
    if (!value) continue
    if (value.length > CAPABILITY_MAX) return { ok: false, code: 'capability_too_long', message: `each capability must be under ${CAPABILITY_MAX} characters.` }
    if (!capabilities.includes(value)) capabilities.push(value)
  }
  if (capabilities.length > MAX_CAPABILITIES) {
    return { ok: false, code: 'too_many_capabilities', message: `list at most ${MAX_CAPABILITIES} capabilities.` }
  }

  const homepage = cleanUrl(input.homepage, 'homepage')
  if (!homepage.ok) return { ok: false, code: 'invalid_homepage', message: homepage.message }
  const callback = cleanUrl(input.callbackUrl, 'callbackUrl')
  if (!callback.ok) return { ok: false, code: 'invalid_callback', message: callback.message }

  return {
    ok: true,
    value: { name, slug: slugify(name), description, capabilities, homepage: homepage.value, callbackUrl: callback.value },
  }
}

/** A caller is either a signed-in user or a bearer key. Both reduce to a user id. */
async function resolveCaller(c: any): Promise<{ userId: string; keyId: string | null } | null> {
  const session = await readSession(c).catch(() => null)
  if (session?.id) return { userId: session.id, keyId: null }
  const auth = c.req.header('authorization') ?? ''
  const secret = auth.replace(/^Bearer\s+/i, '').trim()
  if (!secret.startsWith('sk-thirdeye-')) return null
  const key = await one(`SELECT id, user_id, revoked_at FROM api_keys WHERE key_hash = $1`, [hashSecret(secret)])
  if (!key || key.revoked_at) return null
  return { userId: key.user_id, keyId: key.id }
}

/** The identity behind the presented agent key, or null when the key is a plain user key. */
async function resolveAgent(c: any): Promise<any | null> {
  const auth = c.req.header('authorization') ?? ''
  const secret = auth.replace(/^Bearer\s+/i, '').trim()
  if (!secret.startsWith('sk-thirdeye-')) return null
  return await one(
    `SELECT a.*, k.id AS key_id FROM api_keys k
     JOIN agent_identities a ON a.id = k.agent_identity_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashSecret(secret)]
  )
}

const listing = (a: any) => ({
  slug: a.slug,
  name: a.name,
  description: a.description,
  capabilities: a.capabilities ?? [],
  homepage: a.homepage,
  created_at: a.created_at,
})

export function registerAgentApiRoutes(app: SessionApp): void {
  /**
   * Registration. A unique-slug collision is retried with a numeric suffix rather than failing,
   * because two agents may legitimately share a name and the caller should not have to invent one.
   */
  app.post('/api/v1/agents/register', async (c) => {
    const limit = await checkBucketLimit(clientBucket('agent_register', c), AGENT_REGISTER_PER_HOUR)
    if (!limit.ok) {
      c.header('retry-after', String(limit.reset_seconds))
      return c.json({ error: { message: 'Too many registrations from this client. Try again later.', type: 'rate_limit', code: 429 } }, 429)
    }

    const caller = await resolveCaller(c)
    if (!caller) {
      return c.json({ error: { message: 'Sign in, or present an API key, to register an agent.', type: 'auth', code: 401 } }, 401)
    }

    const raw: any = await c.req.json().catch(() => null)
    const parsed = validateAgent(raw ?? {})
    if (!parsed.ok) {
      return c.json({ error: { message: parsed.message, type: 'invalid_request', code: 400, detail: parsed.code } }, 400)
    }

    // Collisions get a random suffix rather than a counter: a bounded counter can run out and then
    // insert a slug that already exists, which surfaces as a 500 instead of a handled state.
    let slug = parsed.value.slug
    for (let attempt = 0; attempt < 8; attempt++) {
      const taken = await one(`SELECT 1 AS t FROM agent_identities WHERE slug = $1`, [slug])
      if (!taken) break
      slug = `${parsed.value.slug}-${newId().slice(-4)}`
    }

    const id = newId()
    let agent: any
    try {
      agent = await one(
        `INSERT INTO agent_identities (id, owner_user_id, slug, name, description, capabilities, homepage, callback_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, caller.userId, slug, parsed.value.name, parsed.value.description, JSON.stringify(parsed.value.capabilities), parsed.value.homepage, parsed.value.callbackUrl]
      )
    } catch (err: any) {
      if (String(err?.code) === '23505' || /unique/i.test(String(err?.message))) {
        return c.json({ error: { message: 'That slug was claimed while registering. Retry, or choose a different name.', type: 'conflict', code: 409 } }, 409)
      }
      throw err
    }

    const { secret, row } = await createApiKey(caller.userId, `agent:${slug}`, 60, 250000, null)
    await query(`UPDATE api_keys SET agent_identity_id = $1 WHERE id = $2`, [id, row.id])

    return c.json(
      {
        agent: listing(agent),
        key: { secret, prefix: row.key_prefix, rpm: row.rpm, tpm: row.tpm },
        billing: 'This key bills your account. An agent identity cannot hold its own balance.',
        note: 'The key secret is shown once. Store it now.',
      },
      201
    )
  })

  /** The caller's own identity, with what its key has spent. */
  app.get('/api/v1/agents/me', async (c) => {
    const agent = await resolveAgent(c)
    if (!agent) {
      return c.json({ error: { message: 'This key does not speak for an agent identity.', type: 'auth', code: 403 } }, 403)
    }
    const spend = await one(
      `SELECT COALESCE(SUM(cost_usd_micros),0)::bigint AS micros, COUNT(*)::int AS calls,
              MAX(created_at) AS last_call
       FROM usage_events WHERE api_key_id = $1`,
      [agent.key_id]
    ).catch(() => null)
    return c.json({
      agent: { ...listing(agent), callback_url: agent.callback_url, status: agent.status },
      usage: { billed_usd_micros: spend?.micros ?? '0', calls: spend?.calls ?? 0, last_call: spend?.last_call ?? null },
    })
  })

  app.patch('/api/v1/agents/me', async (c) => {
    const agent = await resolveAgent(c)
    if (!agent) {
      return c.json({ error: { message: 'This key does not speak for an agent identity.', type: 'auth', code: 403 } }, 403)
    }
    const body: any = await c.req.json().catch(() => ({}))
    // Name and description are validated together with the current values so a partial edit cannot
    // slip past the length rules that a full registration has to satisfy.
    const merged = validateAgent({
      name: body.name ?? agent.name,
      description: body.description ?? agent.description,
      capabilities: body.capabilities ?? agent.capabilities,
      homepage: body.homepage ?? agent.homepage,
      callbackUrl: body.callbackUrl ?? agent.callback_url,
    })
    if (!merged.ok) {
      return c.json({ error: { message: merged.message, type: 'invalid_request', code: 400, detail: merged.code } }, 400)
    }
    const updated = await one(
      `UPDATE agent_identities SET name=$1, description=$2, capabilities=$3, homepage=$4, callback_url=$5, updated_at=now()
       WHERE id=$6 RETURNING *`,
      [merged.value.name, merged.value.description, JSON.stringify(merged.value.capabilities), merged.value.homepage, merged.value.callbackUrl, agent.id]
    )
    return c.json({ agent: { ...listing(updated), callback_url: updated.callback_url, status: updated.status } })
  })

  /** Retiring is a status change plus key revocation, not a delete: the spend history must survive. */
  app.delete('/api/v1/agents/me', async (c) => {
    const agent = await resolveAgent(c)
    if (!agent) {
      return c.json({ error: { message: 'This key does not speak for an agent identity.', type: 'auth', code: 403 } }, 403)
    }
    await query(`UPDATE agent_identities SET status='retired', updated_at=now() WHERE id=$1`, [agent.id])
    await query(`UPDATE api_keys SET revoked_at=now() WHERE agent_identity_id=$1 AND revoked_at IS NULL`, [agent.id])
    return c.json({ retired: true, slug: agent.slug })
  })

  /** Public directory: identity and claims only. No owner, no spend, no key prefix. */
  app.get('/api/v1/agents/directory', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100)
    const rows = await query(
      `SELECT slug, name, description, capabilities, homepage, created_at
       FROM agent_identities WHERE status = 'active' ORDER BY created_at DESC LIMIT $1`,
      [limit]
    )
    return c.json({ agents: rows.rows.map(listing), count: rows.rows.length })
  })
}
