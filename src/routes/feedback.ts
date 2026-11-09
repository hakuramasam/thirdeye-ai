import type { SessionApp } from '../lib/session.js'
import { readSession } from '../lib/session.js'
import { query, one } from '../db/index.js'
import { checkBucketLimit } from '../lib/ratelimit.js'
import { clientBucket, FEEDBACK_RPM } from './auth.js'
import { env, newId } from '../lib/env.js'

const KINDS = new Set(['idea', 'bug', 'billing', 'docs', 'agent', 'partnership', 'other'])
const SEVERITIES = new Set(['low', 'normal', 'high', 'blocking'])
const STATUSES = new Set(['new', 'triaged', 'planned', 'fixed', 'declined'])

export type FeedbackInput = {
  kind?: unknown
  title?: unknown
  body?: unknown
  page?: unknown
  contact?: unknown
  severity?: unknown
}

export type ValidatedFeedback = {
  kind: string
  title: string
  body: string
  page: string | null
  contact: string | null
  severity: string
}

/**
 * Validation is a pure function so the rules can be tested without a request.
 *
 * Length caps exist because this endpoint is public: an unbounded body is a way to fill the
 * database from a script. The title minimum is small but real, since "fix it" tells us nothing and
 * a triage queue full of them is worse than an empty one.
 */
export function validateFeedback(input: FeedbackInput): { ok: true; value: ValidatedFeedback } | { ok: false; code: string; message: string } {
  const kind = String(input.kind ?? 'idea').trim().toLowerCase()
  if (!KINDS.has(kind)) return { ok: false, code: 'invalid_kind', message: `kind must be one of ${[...KINDS].join(', ')}` }

  const title = String(input.title ?? '').trim()
  if (title.length < 4) return { ok: false, code: 'title_too_short', message: 'Give the report a title of at least 4 characters.' }
  if (title.length > 160) return { ok: false, code: 'title_too_long', message: 'Keep the title under 160 characters.' }

  const body = String(input.body ?? '').trim()
  if (body.length < 10) return { ok: false, code: 'body_too_short', message: 'Describe it in at least 10 characters.' }
  if (body.length > 4000) return { ok: false, code: 'body_too_long', message: 'Keep the description under 4000 characters.' }

  const severity = String(input.severity ?? 'normal').trim().toLowerCase()
  if (!SEVERITIES.has(severity)) return { ok: false, code: 'invalid_severity', message: `severity must be one of ${[...SEVERITIES].join(', ')}` }

  const page = input.page === undefined || input.page === null ? null : String(input.page).trim().slice(0, 200) || null
  const contact = input.contact === undefined || input.contact === null ? null : String(input.contact).trim().slice(0, 320) || null

  return { ok: true, value: { kind, title, body, page, contact, severity } }
}

export function registerFeedbackRoutes(app: SessionApp): void {
  /**
   * Public intake. Anonymous is allowed on purpose: the people whose complaints matter most are
   * often the ones who could not get far enough to sign in. Attribution is best effort via the
   * session cookie, and the rate limit is per client rather than per account because an anonymous
   * flood has no account to charge.
   */
  app.post('/api/feedback', async (c) => {
    const limit = await checkBucketLimit(clientBucket('feedback', c), FEEDBACK_RPM)
    if (!limit.ok) {
      c.header('retry-after', String(limit.reset_seconds))
      return c.json({ error: { message: 'Too many reports from this client. Try again in a minute.', type: 'rate_limit', code: 429 } }, 429)
    }

    let raw: any = {}
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: { message: 'Expected a JSON body.', type: 'invalid_request', code: 400 } }, 400)
    }

    const parsed = validateFeedback(raw || {})
    if (!parsed.ok) return c.json({ error: { message: parsed.message, type: 'invalid_request', code: 400, detail: parsed.code } }, 400)

    const user = await readSession(c).catch(() => null)
    const id = newId()
    await query(
      `INSERT INTO feedback (id, user_id, kind, title, body, page, contact, severity, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new')`,
      [id, user?.id ?? null, parsed.value.kind, parsed.value.title, parsed.value.body, parsed.value.page, parsed.value.contact, parsed.value.severity]
    )

    return c.json({ id, status: 'new', received: true }, 201)
  })

  /** What the caller has already sent, so a reporter can see it was not swallowed. */
  app.get('/api/feedback/mine', async (c) => {
    const user = await readSession(c)
    if (!user) return c.json({ error: { message: 'Sign in to see your reports.', type: 'auth', code: 401 } }, 401)
    const res = await query(
      `SELECT id, kind, title, status, severity, note, created_at FROM feedback WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    )
    return c.json({ items: res.rows })
  })

  /** Triage queue. Owner-only: the reports can contain contact details and unflattering findings. */
  app.get('/api/admin/feedback', async (c) => {
    if (c.req.header('x-master-key') !== env.masterKey) {
      return c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
    }
    const status = c.req.query('status')
    const kind = c.req.query('kind')
    const where: string[] = []
    const params: any[] = []
    if (status && STATUSES.has(status)) {
      params.push(status)
      where.push(`status = $${params.length}`)
    }
    if (kind && KINDS.has(kind)) {
      params.push(kind)
      where.push(`kind = $${params.length}`)
    }
    const sql = `SELECT id, user_id, kind, title, body, page, contact, severity, status, note, created_at
                 FROM feedback ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT 200`
    const res = await query(sql, params)
    const counts = await query(`SELECT status, count(*)::int AS n FROM feedback GROUP BY status`)
    return c.json({ items: res.rows, counts: counts.rows })
  })

  app.patch('/api/admin/feedback/:id', async (c) => {
    if (c.req.header('x-master-key') !== env.masterKey) {
      return c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
    }
    const body: any = await c.req.json().catch(() => ({}))
    const status = body?.status === undefined ? null : String(body.status)
    const note = body?.note === undefined ? null : String(body.note).slice(0, 1000)
    if (status && !STATUSES.has(status)) {
      return c.json({ error: { message: `status must be one of ${[...STATUSES].join(', ')}`, type: 'invalid_request', code: 400 } }, 400)
    }
    if (!status && note === null) {
      return c.json({ error: { message: 'Nothing to change.', type: 'invalid_request', code: 400 } }, 400)
    }
    const row = await one(
      `UPDATE feedback SET
         status = COALESCE($1, status),
         note = COALESCE($2, note),
         updated_at = now()
       WHERE id = $3
       RETURNING id, status, note, updated_at`,
      [status, note, c.req.param('id')]
    )
    if (!row) return c.json({ error: { message: 'No such report.', type: 'not_found', code: 404 } }, 404)
    return c.json(row)
  })
}
