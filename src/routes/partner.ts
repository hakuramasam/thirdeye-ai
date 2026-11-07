/**
 * Partner hub: the private surface where the owner, this agent and named external
 * partners (Vesper today, more later) see the same integration state and talk to
 * each other.
 *
 * Access is server-side only. There is no client-side gate: an agent gets a bearer
 * token whose sha256 is stored, scoped to read or write, and revocable at any time.
 * The owner uses the normal session cookie. Every write is audited.
 */
import { Hono, type Context } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { one, query } from '../db/index.js'
import { newId } from '../lib/env.js'
import { requireUser } from '../lib/session.js'
import type { AppEnv } from '../lib/types.js'

export type PartnerScope = 'read' | 'write' | 'admin'

export type PartnerIdentity = { name: string; org: string; kind: 'owner' | 'agent'; scopes: PartnerScope[] }

/** Tokens are shown once and stored only as a hash. */
export function hashPartnerKey(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}

export function newPartnerKey(): { token: string; hash: string; prefix: string } {
  const token = `pk-${randomBytes(24).toString('base64url')}`
  return { token, hash: hashPartnerKey(token), prefix: token.slice(0, 11) }
}

export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}

/** A partner's thread name, derived from their org so it is stable and readable. */
export function threadFor(org: string): string {
  const slug = String(org || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'general'
}

/**
 * Write throttling. Partners are limited; the owner is not. Kept pure so the
 * decision is testable without a database.
 */
export const PARTNER_WRITE_LIMIT = 20
export const PARTNER_WRITE_WINDOW_SECONDS = 600

export function isOverWriteLimit(recentCount: number, limit = PARTNER_WRITE_LIMIT): boolean {
  return recentCount >= limit
}

export function hasScope(scopes: PartnerScope[] | null | undefined, needed: PartnerScope): boolean {
  const list = scopes ?? []
  if (list.includes('admin')) return true
  return list.includes(needed)
}

/**
 * Resolve the caller: an owner session, or a partner bearer token.
 * Returns null when neither is valid, so callers fail closed.
 */
export async function resolvePartner(c: Context<AppEnv>): Promise<PartnerIdentity | null> {
  const token = bearerToken(c.req.header('authorization'))
  if (token) {
    const row = await one(
      `SELECT name, org, kind, scopes FROM partner_agents
        WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hashPartnerKey(token)]
    )
    if (!row) return null
    await query('UPDATE partner_agents SET last_seen_at = now() WHERE key_hash = $1', [hashPartnerKey(token)])
    return { name: row.name, org: row.org, kind: 'agent', scopes: (row.scopes as PartnerScope[]) ?? [] }
  }
  const user = c.get('user')
  if (user) return { name: 'owner', org: 'Thirdeye', kind: 'owner', scopes: ['read', 'write', 'admin'] }
  return null
}

/**
 * Records a write attempt and reports whether this identity is over its limit.
 * Called before the write lands, so a throttled partner changes nothing.
 */
async function throttle(actor: string): Promise<{ allowed: boolean; remaining: number }> {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM partner_write_log
      WHERE actor = $1 AND created_at > now() - ($2 || ' seconds')::interval`,
    [actor, String(PARTNER_WRITE_WINDOW_SECONDS)]
  )
  const used = Number(r.rows[0]?.n ?? 0)
  if (isOverWriteLimit(used)) return { allowed: false, remaining: 0 }
  await query('INSERT INTO partner_write_log (id, actor, action) VALUES ($1, $2, $3)', [newId(), actor, 'write'])
  return { allowed: true, remaining: PARTNER_WRITE_LIMIT - used - 1 }
}

async function audit(actor: string, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await query('INSERT INTO partner_audit (id, actor, action, detail) VALUES ($1, $2, $3, $4)', [
    newId(), actor, action, JSON.stringify(detail),
  ])
}

const PUBLIC_URL = process.env.PUBLIC_BASE_URL || 'https://thirdeye-ai-alpha.vercel.app'

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Thirdeye partner hub</title>
<style>
:root{color-scheme:dark}body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b0c10;color:#e8e8ea}
main{max-width:880px;margin:0 auto;padding:28px 20px 64px}h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b8f98;margin:28px 0 10px}
.card{background:#14161c;border:1px solid #232733;border-radius:10px;padding:14px 16px;margin:8px 0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.muted{color:#8b8f98}table{width:100%;border-collapse:collapse;font-size:13.5px}td{padding:5px 0;border-bottom:1px solid #1d212b;vertical-align:top}td:first-child{color:#8b8f98;width:42%}
textarea,input{width:100%;box-sizing:border-box;background:#0f1116;border:1px solid #2a2f3c;color:#e8e8ea;border-radius:8px;padding:9px 10px;font:inherit}
button{margin-top:8px;background:#2b6cff;color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}
.tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:999px;background:#1c2230;color:#9fb4e0;margin-left:6px}
</style></head><body><main>
<h1>Thirdeye partner hub</h1>
<div class="muted">Private integration surface. Owner, agent and named partners only.</div>
<div id="who" class="mono" style="margin-top:10px"></div>
<h2>Integration state</h2><div id="state" class="card"></div>
<h2>Open requests</h2><div id="requests"></div>
<h2>Thread</h2><div id="thread"></div>
<div class="card"><textarea id="msg" rows="3" placeholder="Message the hub as the owner"></textarea><button onclick="send()">Send</button></div>
<h2>Partner keys</h2><div id="keys" class="card mono muted">owner only</div>
<script>
const j = (u,o)=>fetch(u,{credentials:'include',headers:{'content-type':'application/json'},...o}).then(r=>r.json());
const esc = s => String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){
  const h = await j('/api/partner/hub');
  document.getElementById('who').textContent = h.identity ? h.identity.name+' · '+h.identity.org+' · '+h.identity.kind : 'not signed in';
  const s = h.integration||{};
  document.getElementById('state').innerHTML = Object.entries(s).map(([k,v])=>'<table><tr><td>'+esc(k)+'</td><td class="mono">'+esc(typeof v==='string'?v:JSON.stringify(v))+'</td></tr></table>').join('');
  document.getElementById('requests').innerHTML = (h.requests||[]).map(r=>'<div class="card"><strong>'+esc(r.title)+'</strong><span class="tag">'+esc(r.direction)+'</span><span class="tag">'+esc(r.status)+'</span><div class="muted" style="margin-top:6px">'+esc(r.detail)+'</div></div>').join('')||'<div class="muted">none open</div>';
  document.getElementById('thread').innerHTML = (h.messages||[]).map(m=>'<div class="card"><div class="muted mono">'+esc(m.author_name)+' · '+esc(new Date(m.created_at).toISOString().slice(0,16))+'</div><div style="margin-top:6px;white-space:pre-wrap">'+esc(m.body)+'</div></div>').join('')||'<div class="muted">no messages yet</div>';
  if (h.keys) document.getElementById('keys').innerHTML = h.keys.map(k=>esc(k.name)+' · '+esc(k.org)+' · '+esc(k.key_prefix)+'… · '+esc(k.scopes.join(','))+(k.revoked_at?' · revoked':'')).join('<br>')||'no keys issued';
}
async function send(){const t=document.getElementById('msg');if(!t.value.trim())return;await j('/api/partner/messages',{method:'POST',body:JSON.stringify({body:t.value})});t.value='';load();}
load();
</script></main></body></html>`

export function registerPartnerRoutes(app: Hono<AppEnv>): void {
  // Owner-facing page. Rendered server-side, but all data comes from the authed API.
  app.get('/partner', async (c) => c.html(PAGE))

  app.get('/api/partner/hub', async (c) => {
    const who = await resolvePartner(c)
    if (!who) return c.json({ error: { message: 'Unauthorized', type: 'partner', code: 'unauthorized' } }, 401)
    if (!hasScope(who.scopes, 'read')) return c.json({ error: { message: 'Missing read scope', type: 'partner', code: 'forbidden' } }, 403)

    const [agentList, requests, messages, keys] = await Promise.all([
      query('SELECT name, mcp_servers, x402_enabled, x402_allowed_sellers, x402_max_per_call_usd_micros FROM agents ORDER BY created_at ASC LIMIT 5'),
      query(`SELECT id, title, detail, direction, status, due_at, created_at FROM partner_requests
              WHERE status = 'open' ORDER BY created_at DESC LIMIT 20`),
      who.kind === 'owner'
        // The owner supervises every thread, so they see them all, labelled.
        ? query('SELECT author_name, body, thread, created_at FROM partner_messages ORDER BY created_at DESC LIMIT 40')
        // A partner sees only their own thread, enforced in SQL rather than in the UI.
        : query('SELECT author_name, body, thread, created_at FROM partner_messages WHERE thread = $1 ORDER BY created_at DESC LIMIT 40', [threadFor(who.org)]),
      who.scopes.includes('admin')
        ? query('SELECT name, org, key_prefix, scopes, created_at, revoked_at, last_seen_at FROM partner_agents ORDER BY created_at ASC')
        : Promise.resolve({ rows: [], rowCount: 0 }),
    ])

    const a = agentList.rows[0] ?? {}
    return c.json({
      identity: who,
      integration: {
        public_base_url: PUBLIC_URL,
        mcp_servers: a.mcp_servers ?? [],
        x402_enabled: a.x402_enabled ?? false,
        allowlisted_hosts: a.x402_allowed_sellers ?? [],
        per_call_cap_usd: Number(a.x402_max_per_call_usd_micros ?? 20000) / 1_000_000,
        note: 'Cap and allowlist are the live values; nothing is paid to a partner until a host is allowlisted.',
      },
      thread: who.kind === 'owner' ? 'all' : threadFor(who.org),
      requests: requests.rows,
      messages: requests.rows.slice(0, 0).concat(messages.rows).reverse(),
      keys: who.scopes.includes('admin') ? keys.rows : undefined,
    })
  })

  app.post('/api/partner/messages', async (c) => {
    const who = await resolvePartner(c)
    if (!who) return c.json({ error: { message: 'Unauthorized', type: 'partner', code: 'unauthorized' } }, 401)
    if (!hasScope(who.scopes, 'write')) return c.json({ error: { message: 'Missing write scope', type: 'partner', code: 'forbidden' } }, 403)
    const payload = await c.req.json().catch(() => ({}))
    const body = String(payload?.body ?? '').trim()
    if (!body) return c.json({ error: { message: 'body is required', type: 'partner', code: 'invalid_request' } }, 400)
    if (body.length > 4000) return c.json({ error: { message: 'body too long', type: 'partner', code: 'invalid_request' } }, 400)
    if (who.kind === 'agent') {
      const t = await throttle(who.name)
      if (!t.allowed) {
        return c.json({ error: { message: `Rate limit: ${PARTNER_WRITE_LIMIT} writes per ${PARTNER_WRITE_WINDOW_SECONDS}s`, type: 'partner', code: 'rate_limited' } }, 429)
      }
    }
    // A partner can only write into their own thread; the owner may target any thread.
    const thread = who.kind === 'owner' ? threadFor(String(payload?.thread ?? 'general')) : threadFor(who.org)
    const id = newId()
    await query('INSERT INTO partner_messages (id, author_name, author_kind, body, thread) VALUES ($1, $2, $3, $4, $5)', [
      id, who.name, who.kind, body, thread,
    ])
    await audit(who.name, 'message.create', { id })
    return c.json({ ok: true, id })
  })

  app.post('/api/partner/requests', async (c) => {
    const who = await resolvePartner(c)
    if (!who) return c.json({ error: { message: 'Unauthorized', type: 'partner', code: 'unauthorized' } }, 401)
    if (!hasScope(who.scopes, 'write')) return c.json({ error: { message: 'Missing write scope', type: 'partner', code: 'forbidden' } }, 403)
    const b = await c.req.json().catch(() => ({}))
    const title = String(b?.title ?? '').trim()
    if (!title) return c.json({ error: { message: 'title is required', type: 'partner', code: 'invalid_request' } }, 400)
    if (who.kind === 'agent') {
      const t = await throttle(who.name)
      if (!t.allowed) {
        return c.json({ error: { message: `Rate limit: ${PARTNER_WRITE_LIMIT} writes per ${PARTNER_WRITE_WINDOW_SECONDS}s`, type: 'partner', code: 'rate_limited' } }, 429)
      }
    }
    const id = newId()
    await query(
      `INSERT INTO partner_requests (id, title, detail, direction, status, due_at)
       VALUES ($1, $2, $3, $4, 'open', $5)`,
      [id, title, b?.detail ? String(b.detail).slice(0, 2000) : null, who.kind === 'owner' ? 'from_thirdeye' : 'from_partner', b?.due_at ?? null]
    )
    await audit(who.name, 'request.create', { id, title })
    return c.json({ ok: true, id })
  })

  app.patch('/api/partner/requests/:id', async (c) => {
    const who = await resolvePartner(c)
    if (!who) return c.json({ error: { message: 'Unauthorized', type: 'partner', code: 'unauthorized' } }, 401)
    if (!hasScope(who.scopes, 'write')) return c.json({ error: { message: 'Missing write scope', type: 'partner', code: 'forbidden' } }, 403)
    const status = String((await c.req.json().catch(() => ({})))?.status ?? '')
    if (!['open', 'answered', 'done', 'dropped'].includes(status)) {
      return c.json({ error: { message: 'invalid status', type: 'partner', code: 'invalid_request' } }, 400)
    }
    await query('UPDATE partner_requests SET status = $1, updated_at = now() WHERE id = $2', [status, c.req.param('id')])
    await audit(who.name, 'request.update', { id: c.req.param('id'), status })
    return c.json({ ok: true })
  })

  // Key issuance is owner-only: a partner can never mint or widen its own access.
  app.post('/api/partner/keys', requireUser, async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const name = String(b?.name ?? '').trim()
    const org = String(b?.org ?? '').trim()
    const scopes: PartnerScope[] = Array.isArray(b?.scopes) ? b.scopes.filter((s: string) => ['read', 'write', 'admin'].includes(s)) : ['read']
    if (!name || !org) return c.json({ error: { message: 'name and org are required', type: 'partner', code: 'invalid_request' } }, 400)
    if (scopes.includes('admin') && b?.confirm_admin !== true) {
      return c.json({ error: { message: 'admin scope requires confirm_admin: true', type: 'partner', code: 'invalid_request' } }, 400)
    }
    const { token, hash, prefix } = newPartnerKey()
    const id = newId()
    await query('INSERT INTO partner_agents (id, name, org, kind, key_hash, key_prefix, scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      id, name, org, 'agent', hash, prefix, JSON.stringify(scopes),
    ])
    await audit('owner', 'key.issue', { id, name, org, scopes })
    return c.json({ ok: true, id, token, prefix, scopes, note: 'Shown once. Store it on the partner side; only its hash is kept.' })
  })

  app.delete('/api/partner/keys/:id', requireUser, async (c) => {
    await query('UPDATE partner_agents SET revoked_at = now() WHERE id = $1', [c.req.param('id')])
    await audit('owner', 'key.revoke', { id: c.req.param('id') })
    return c.json({ ok: true })
  })
}
