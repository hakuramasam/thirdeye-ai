/**
 * Durable, locked and idempotent scheduled agent runs.
 *
 * Implements the ARCHITECT design from the 2026-11-09 sprint, adapted to this schema.
 * One row per (agent, schedule slot). Acquisition is a single statement that either
 * inserts the row or steals it when the previous holder's TTL has expired, so two
 * overlapping cron invocations cannot both own the same slot.
 *
 * Terminal states matter: a COMPLETED slot is never re-runnable (that is the
 * idempotency guarantee), while a FAILED slot becomes stealable after a short back-off
 * so a transient crash does not silently drop a scheduled run.
 */

import { one, query } from '../db/index.js'

export type LockStatus = 'LOCKED' | 'COMPLETED' | 'FAILED'

export type ScheduleLock = {
  id: string | number
  agentId: string
  lockKey: string
  runId: string
  status: LockStatus
  how: 'inserted' | 'stolen'
}

export const DEFAULT_TTL_SECONDS = 600
export const FAILED_RETRY_BACKOFF_SECONDS = 60

/** Deterministic slot key for a cron tick: one slot per agent per wall-clock minute. */
export function cronSlotKey(at: Date = new Date()): string {
  return `cron:${at.toISOString().slice(0, 16)}`
}

/**
 * Try to take the lock for (agentId, lockKey). Returns the owned lock, or null when another
 * holder has a fresh lock or the slot already completed.
 */
export async function acquireScheduleLock(
  agentId: string,
  lockKey: string,
  opts: { runId: string; ttlSeconds?: number; scheduledAt?: Date } = { runId: '' }
): Promise<ScheduleLock | null> {
  const ttl = Math.max(30, Math.floor(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS))
  const scheduledAt = (opts.scheduledAt ?? new Date()).toISOString()

  const res = await query(
    `WITH candidate AS (
        INSERT INTO agent_schedule_lock (agent_id, lock_key, scheduled_at, run_id, lock_expires_at, status)
        VALUES ($1, $2, $3::timestamptz, $4, now() + make_interval(secs => $5::int), 'LOCKED')
        ON CONFLICT (agent_id, lock_key) DO NOTHING
        RETURNING id, run_id, status
     ), stolen AS (
        UPDATE agent_schedule_lock
           SET run_id = $4,
               lock_acquired_at = now(),
               lock_expires_at = now() + make_interval(secs => $5::int),
               status = 'LOCKED',
               heartbeat_ts = NULL
         WHERE agent_id = $1
           AND lock_key = $2
           AND lock_expires_at < now()
           AND status IN ('LOCKED', 'FAILED')
        RETURNING id, run_id, status
     )
     SELECT id, run_id, status, 'inserted' AS how FROM candidate
     UNION ALL
     SELECT id, run_id, status, 'stolen' AS how FROM stolen
     LIMIT 1`,
    [agentId, lockKey, scheduledAt, opts.runId, ttl]
  )

  const row = res.rows[0]
  if (!row) return null
  return {
    id: row.id,
    agentId,
    lockKey,
    runId: String(row.run_id),
    status: row.status as LockStatus,
    how: row.how as 'inserted' | 'stolen',
  }
}

/** Refresh the TTL of a lock we still own. No-op if we no longer own it. */
export async function heartbeatScheduleLock(lockId: string | number, runId: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
  const res = await query(
    `UPDATE agent_schedule_lock
        SET heartbeat_ts = now(),
            lock_expires_at = now() + make_interval(secs => $3::int)
      WHERE id = $1 AND run_id = $2 AND status = 'LOCKED'`,
    [lockId, runId, Math.max(30, Math.floor(ttlSeconds))]
  )
  return res.rowCount > 0
}

/**
 * Finish a slot. COMPLETED is terminal, so a replay with the same key can never run again.
 * FAILED keeps the row but makes it stealable after a short back-off.
 */
export async function finishScheduleLock(
  lockId: string | number,
  runId: string,
  status: 'COMPLETED' | 'FAILED',
  meta: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `UPDATE agent_schedule_lock
        SET status = $3,
            lock_expires_at = now() + make_interval(secs => $4::int),
            metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
      WHERE id = $1 AND run_id = $2`,
    [lockId, runId, status, status === 'FAILED' ? FAILED_RETRY_BACKOFF_SECONDS : 0, JSON.stringify(meta)]
  )
}

/** Read a slot without taking it, for diagnostics and the cron response body. */
export async function peekScheduleLock(agentId: string, lockKey: string): Promise<any | null> {
  return one(`SELECT id, status, run_id, lock_acquired_at, lock_expires_at FROM agent_schedule_lock WHERE agent_id = $1 AND lock_key = $2`, [agentId, lockKey])
}
