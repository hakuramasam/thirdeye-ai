/**
 * Addressable artifact registry (PH2-003).
 *
 * Before this module an artifact only existed as prose inside a delegation report, so every hop
 * truncated it a little more and the last reader saw a summary of a summary. Now the producer
 * stores the full text once, under an address, and the handoff carries the address plus a short
 * head of the text. A reader that needs the whole thing fetches it by address.
 *
 * The address is stable and cheap to type (`art_` + 20 hex), because it appears in prompts, in
 * audit rows and in the UI. Content is hashed so an identical handoff twice in one chain is stored
 * once instead of growing a version per retry, and a genuinely different handoff of the same kind
 * in the same stage becomes version 2 rather than silently replacing version 1.
 */

import { createHash, randomBytes } from 'node:crypto'
import { query, one } from '../db/index.js'
import { getPipeline } from './pipeline.js'
import { recordArtifactEvent, type AuditContext } from './audit-log.js'

/** Kinds a producer may declare. Pipeline stages name their output, so these mirror those names. */
export const ARTIFACT_KINDS = [
  'task',
  'acceptance_criteria',
  'design',
  'diagnosis',
  'pull_request',
  'diff',
  'test_report',
  'review',
  'release',
  'changelog_entry',
  'report',
  'note',
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/**
 * A single artifact larger than this is not a handoff, it is a data dump: the agent would have
 * spent its whole budget generating it and the reader its whole context reading it. Refuse instead
 * of truncating, so the producer learns the shape is wrong rather than losing its tail quietly.
 */
export const MAX_ARTIFACT_CHARS = 200_000
/** What a reader gets per call. Bounded so one read cannot swallow the reader's context. */
export const MAX_ARTIFACT_READ_CHARS = 40_000

export type ArtifactRow = {
  id: string
  user_id: string
  correlation_id: string
  run_id: string | null
  parent_run_id: string | null
  task_id: string | null
  pipeline_id: string | null
  stage_id: string | null
  kind: string
  title: string
  content: string
  content_sha256: string
  version: number
  bytes: number
  created_by: string | null
  metadata: Record<string, unknown> | string
  created_at: string
}

export type ArtifactSummary = {
  id: string
  kind: string
  title: string
  version: number
  bytes: number
  created_by: string | null
  created_at: string
}

export type StoredArtifact = {
  id: string
  kind: string
  title: string
  version: number
  bytes: number
  sha256: string
  /** True when identical content already existed in this chain, so no new row was written. */
  deduped: boolean
}

export type StoreArtifactInput = {
  userId: string
  kind: string
  content: string
  title?: string
  correlationId?: string | null
  runId?: string | null
  parentRunId?: string | null
  taskId?: string | null
  pipelineId?: string | null
  stageId?: string | null
  createdBy?: string | null
  metadata?: Record<string, unknown>
}

export function newArtifactId(): string {
  return `art_${randomBytes(10).toString('hex')}`
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The kind a stage hands on. A declared pipeline owns this decision: the stage says what it
 * produces, so a run cannot relabel its own output. Free-form runs report a plain `report`.
 */
export function kindForStage(pipelineId: string | null | undefined, stageId: string | null | undefined): ArtifactKind {
  const pipeline = getPipeline(pipelineId ?? null)
  const stage = pipeline?.stages.find((s) => s.id === stageId)
  const produced = stage?.produces
  return ARTIFACT_KINDS.includes(produced as ArtifactKind) ? (produced as ArtifactKind) : 'report'
}

export type ValidationResult =
  | { ok: true; kind: ArtifactKind; content: string; title: string }
  | { ok: false; code: string; message: string }

export function validateArtifact(input: { kind?: unknown; content?: unknown; title?: unknown }): ValidationResult {
  const kind = String(input.kind ?? '').trim().toLowerCase()
  if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
    return { ok: false, code: 'invalid_kind', message: `kind must be one of ${ARTIFACT_KINDS.join(', ')}` }
  }
  const content = typeof input.content === 'string' ? input.content : ''
  if (!content.trim()) return { ok: false, code: 'empty_content', message: 'an artifact needs content' }
  if (content.length > MAX_ARTIFACT_CHARS) {
    return {
      ok: false,
      code: 'artifact_too_large',
      message: `content is ${content.length} characters; the cap is ${MAX_ARTIFACT_CHARS}. Store the evidence as a separate note artifact and reference it.`,
    }
  }
  const title = String(input.title ?? '').trim().slice(0, 120)
  return { ok: true, kind: kind as ArtifactKind, content, title }
}

/** One line a prompt can carry instead of the whole document. */
export function describeArtifact(a: { id: string; kind: string; version?: number; bytes: number }): string {
  const kb = (a.bytes / 1024).toFixed(1)
  return `${a.id} (${a.kind}${a.version && a.version > 1 ? ` v${a.version}` : ''}, ${kb} kB)`
}

/**
 * Store one artifact and return its address.
 *
 * Dedupe and versioning both key on the chain (correlation id) rather than the run: a retried step
 * hands on the same document and should not create noise, while a corrected document in the same
 * stage is a new version and the earlier one stays readable.
 */
export async function storeArtifact(input: StoreArtifactInput, audit?: AuditContext): Promise<StoredArtifact> {
  const check = validateArtifact(input)
  if (!check.ok) {
    const err = new Error(check.message) as Error & { code?: string }
    err.code = check.code
    throw err
  }
  const content = check.content
  const sha = sha256(content)
  const bytes = bytesOf(content)
  const correlationId = input.correlationId ?? `adhoc_${randomBytes(8).toString('hex')}`
  const title = check.title || `${check.kind} from ${input.createdBy ?? 'agent'}`

  // Same chain, same stage, same bytes: hand back the address that already exists.
  const existing = (await one(
    `SELECT * FROM agent_artifacts
      WHERE user_id = $1 AND correlation_id = $2 AND kind = $3
        AND COALESCE(stage_id, '') = COALESCE($4, '') AND content_sha256 = $5
      ORDER BY version DESC LIMIT 1`,
    [input.userId, correlationId, check.kind, input.stageId ?? null, sha]
  )) as ArtifactRow | null
  if (existing) {
    if (audit) {
      await recordArtifactEvent(audit, { action: 'read', artifactId: existing.id, version: existing.version, metadata: { deduped: true } })
    }
    return { id: existing.id, kind: existing.kind, title: existing.title, version: existing.version, bytes: existing.bytes, sha256: sha, deduped: true }
  }

  const prior = (await one(
    `SELECT max(version) AS max FROM agent_artifacts
      WHERE user_id = $1 AND correlation_id = $2 AND kind = $3 AND COALESCE(stage_id, '') = COALESCE($4, '')`,
    [input.userId, correlationId, check.kind, input.stageId ?? null]
  )) as { max: number | null } | null
  const version = Number(prior?.max ?? 0) + 1
  const id = newArtifactId()
  await query(
    `INSERT INTO agent_artifacts
       (id, user_id, correlation_id, run_id, parent_run_id, task_id, pipeline_id, stage_id,
        kind, title, content, content_sha256, version, bytes, created_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      input.userId,
      correlationId,
      input.runId ?? null,
      input.parentRunId ?? null,
      input.taskId ?? null,
      input.pipelineId ?? null,
      input.stageId ?? null,
      check.kind,
      title,
      content,
      sha,
      version,
      bytes,
      input.createdBy ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  )
  if (audit) {
    await recordArtifactEvent(audit, {
      action: version > 1 ? 'updated' : 'created',
      artifactId: id,
      version,
      metadata: { kind: check.kind, bytes, sha256: sha, stage_id: input.stageId ?? null },
    }).catch(() => null)
  }
  return { id, kind: check.kind, title, version, bytes, sha256: sha, deduped: false }
}

/** Read one artifact, scoped to its owner. A wrong owner is indistinguishable from a missing row. */
export async function readArtifact(userId: string, id: string): Promise<ArtifactRow | null> {
  return (await one(`SELECT * FROM agent_artifacts WHERE id = $1 AND user_id = $2`, [id, userId])) as ArtifactRow | null
}

export type ReadArtifactResult =
  | { ok: true; artifact: ArtifactRow; content: string; truncated: boolean; next_offset: number | null }
  | { ok: false; code: string; message: string }

/**
 * Read with a bounded window. A reader that needs more pages by offset rather than by asking the
 * producer to resend, which is the whole point of an address: the bytes are already here.
 */
export async function readArtifactWindow(
  userId: string,
  id: string,
  opts: { offset?: number; limit?: number } = {}
): Promise<ReadArtifactResult> {
  const clean = String(id ?? '').trim()
  if (!/^art_[0-9a-f]{20}$/.test(clean)) {
    return { ok: false, code: 'invalid_address', message: 'an artifact address looks like art_ followed by 20 hex characters' }
  }
  const row = await readArtifact(userId, clean)
  if (!row) return { ok: false, code: 'not_found', message: `no artifact ${clean} in this account` }
  const limit = Math.min(Math.max(Number(opts.limit ?? MAX_ARTIFACT_READ_CHARS), 1), MAX_ARTIFACT_READ_CHARS)
  const offset = Math.max(Number(opts.offset ?? 0), 0)
  const content = row.content.slice(offset, offset + limit)
  const next = offset + content.length
  return { ok: true, artifact: row, content, truncated: next < row.content.length, next_offset: next < row.content.length ? next : null }
}

export async function listArtifacts(
  userId: string,
  filter: { correlationId?: string | null; taskId?: string | null; kind?: string | null; limit?: number } = {}
): Promise<ArtifactSummary[]> {
  const where = ['user_id = $1']
  const args: unknown[] = [userId]
  if (filter.correlationId) {
    args.push(filter.correlationId)
    where.push(`correlation_id = $${args.length}`)
  }
  if (filter.taskId) {
    args.push(filter.taskId)
    where.push(`task_id = $${args.length}`)
  }
  if (filter.kind) {
    args.push(String(filter.kind).toLowerCase())
    where.push(`kind = $${args.length}`)
  }
  const limit = Math.min(Math.max(Number(filter.limit ?? 50), 1), 200)
  args.push(limit)
  const res = await query(
    `SELECT id, kind, title, version, bytes, created_by, created_at, correlation_id, task_id, stage_id
       FROM agent_artifacts WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${args.length}`,
    args
  )
  return (res.rows as ArtifactRow[]).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    version: r.version,
    bytes: r.bytes,
    created_by: r.created_by,
    created_at: r.created_at,
  }))
}
