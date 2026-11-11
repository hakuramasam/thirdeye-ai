/**
 * Reading artifacts over HTTP (PH2-003). Rate limiting reuses the auth client bucket rather than
 * inventing a new one, so a reader cannot sidestep the per-IP budget by switching routes.
 *
 * The registry exists so an artifact has an address a person, an agent or a dashboard can name.
 * Reads are owner-scoped: a wrong owner and an unknown address answer the same 404, so an address
 * is not a way to probe whether someone else's chain exists.
 */

import type { SessionApp } from '../lib/session.js'
import { readSession } from '../lib/session.js'
import { checkBucketLimit } from '../lib/ratelimit.js'
import { clientBucket, AUTH_NONCE_RPM } from './auth.js'
import { readArtifactWindow, listArtifacts, describeArtifact, MAX_ARTIFACT_READ_CHARS } from '../agents/artifacts.js'

export function registerArtifactsRoutes(app: SessionApp): void {
  // GET /api/artifacts?correlation_id=...&task_id=...&kind=...
  app.get('/api/artifacts', async (c) => {
    const session = await readSession(c)
    if (!session) return c.json({ error: { message: 'Sign in first', type: 'unauthorized', code: 401 } }, 401)
    const limit = await checkBucketLimit(clientBucket('nonce', c), AUTH_NONCE_RPM)
    if (!limit.ok) {
      c.header('retry-after', String(limit.reset_seconds))
      return c.json({ error: { message: 'Too many requests. Try again shortly.', type: 'rate_limit', code: 429 } }, 429)
    }
    const artifacts = await listArtifacts(session.id, {
      correlationId: c.req.query('correlation_id') ?? null,
      taskId: c.req.query('task_id') ?? null,
      kind: c.req.query('kind') ?? null,
      limit: Number(c.req.query('limit') ?? 50),
    })
    return c.json({ data: artifacts })
  })

  // GET /api/artifacts/:id[?offset=0&limit=40000]
  app.get('/api/artifacts/:id', async (c) => {
    const session = await readSession(c)
    if (!session) return c.json({ error: { message: 'Sign in first', type: 'unauthorized', code: 401 } }, 401)
    const limit = await checkBucketLimit(clientBucket('nonce', c), AUTH_NONCE_RPM)
    if (!limit.ok) {
      c.header('retry-after', String(limit.reset_seconds))
      return c.json({ error: { message: 'Too many requests. Try again shortly.', type: 'rate_limit', code: 429 } }, 429)
    }
    const read = await readArtifactWindow(session.id, c.req.param('id'), {
      offset: Number(c.req.query('offset') ?? 0),
      limit: Number(c.req.query('limit') ?? MAX_ARTIFACT_READ_CHARS),
    })
    if (!read.ok) {
      const status = read.code === 'invalid_address' ? 400 : 404
      return c.json({ error: { message: read.message, type: read.code, code: status } }, status as 400 | 404)
    }
    return c.json({
      data: {
        id: read.artifact.id,
        kind: read.artifact.kind,
        title: read.artifact.title,
        version: read.artifact.version,
        bytes: read.artifact.bytes,
        sha256: read.artifact.content_sha256,
        correlation_id: read.artifact.correlation_id,
        run_id: read.artifact.run_id,
        task_id: read.artifact.task_id,
        pipeline_id: read.artifact.pipeline_id,
        stage_id: read.artifact.stage_id,
        created_by: read.artifact.created_by,
        created_at: read.artifact.created_at,
        address: describeArtifact(read.artifact),
        content: read.content,
        truncated: read.truncated,
        next_offset: read.next_offset,
      },
    })
  })
}
