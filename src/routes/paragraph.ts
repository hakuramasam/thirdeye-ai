import type { SessionApp } from '../lib/session.js'
import { env } from '../lib/env.js'
import {
  createDraft,
  getMe,
  listPublicationPosts,
  paragraphConfigured,
  redactKey,
} from '../lib/paragraph.js'

/**
 * Paragraph integration surface, gated by MASTER_KEY like the rest of /api/admin.
 *
 * Read-only checks and drafts live here. Nothing in this file publishes, emails or deletes a
 * post, because the setup guide requires the owner's explicit word for those.
 */
export function registerParagraphRoutes(app: SessionApp) {
  const forbidden = (c: any) =>
    c.req.header('x-master-key') !== env.masterKey
      ? c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
      : null

  /** GET /api/admin/paragraph/me — connectivity check named by the setup guide. */
  app.get('/api/admin/paragraph/me', async (c) => {
    const denied = forbidden(c)
    if (denied) return denied
    if (!paragraphConfigured()) {
      return c.json({ connected: false, reason: 'PARAGRAPH_API_KEY is not set' }, 200)
    }
    const me = await getMe()
    if (!me.ok) return c.json({ connected: false, code: me.code, message: redactKey(me.message) }, me.status === 401 ? 401 : 502)
    return c.json({ connected: true, publication: me.data })
  })

  /** GET /api/admin/paragraph/posts?publication_id=...&limit=... — recent posts. */
  app.get('/api/admin/paragraph/posts', async (c) => {
    const denied = forbidden(c)
    if (denied) return denied
    // Default to the key's own publication, which is the only one it can list.
    let publicationId = c.req.query('publication_id')
    if (!publicationId) {
      const me = await getMe()
      if (!me.ok) return c.json({ error: { message: redactKey(me.message), type: me.code, code: me.status || 502 } }, 502)
      publicationId = (me.data as any)?.id
    }
    if (!publicationId) {
      return c.json({ error: { message: 'publication_id is required', type: 'invalid_request', code: 400 } }, 400)
    }
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 50)
    const posts = await listPublicationPosts(String(publicationId), { limit })
    if (!posts.ok) return c.json({ error: { message: redactKey(posts.message), type: posts.code, code: posts.status || 502 } }, 502)
    return c.json({ publication_id: publicationId, posts: posts.data })
  })

  /**
   * POST /api/admin/paragraph/drafts — create a draft.
   * Drafts stay private, so this needs no separate publishing approval.
   */
  app.post('/api/admin/paragraph/drafts', async (c) => {
    const denied = forbidden(c)
    if (denied) return denied
    const body: any = await c.req.json().catch(() => ({}))
    const title = String(body?.title ?? '').trim()
    if (!title) return c.json({ error: { message: 'title is required', type: 'invalid_request', code: 400 } }, 400)
    const draft = await createDraft({ ...body, title })
    if (!draft.ok) return c.json({ error: { message: redactKey(draft.message), type: draft.code, code: draft.status || 502 } }, 502)
    return c.json({ ok: true, draft: draft.data })
  })
}
