import { env } from '../lib/env.js'

/**
 * Dual-driver database layer.
 *  - DATABASE_URL set  -> hosted Postgres (Neon/Supabase/RDS) via the `pg` driver
 *  - DATABASE_URL unset -> embedded Postgres (PGlite): file-backed locally,
 *    in-memory on serverless (demo mode, data resets on cold start).
 * Both speak the same dialect ($1 params), so all SQL is shared.
 */

export type QueryResult = { rows: any[]; rowCount: number }

let pglite: any = null
let pgPool: any = null

async function getPglite(): Promise<any> {
  if (!pglite) {
    const { PGlite } = await import('@electric-sql/pglite')
    const location = env.databaseUrl ? null : (env.pgliteDir ?? 'memory://')
    pglite = new PGlite(location!)
  }
  return pglite
}

async function getPool(): Promise<any> {
  if (!pgPool) {
    const pgMod: any = await import('pg')
    const pg = pgMod.default ?? pgMod
    pgPool = new pg.Pool({ connectionString: env.databaseUrl, max: 5 })
  }
  return pgPool
}

export function dbMode(): 'postgres' | 'pglite' {
  return env.databaseUrl ? 'postgres' : 'pglite'
}

export async function query(sql: string, params: any[] = []): Promise<QueryResult> {
  if (env.databaseUrl) {
    const pool = await getPool()
    const res: any = await pool.query(sql, params)
    // Multi-statement simple-query (migrate) returns an ARRAY of results.
    if (Array.isArray(res)) {
      const last = res[res.length - 1] ?? {}
      return { rows: last.rows ?? [], rowCount: last.rowCount ?? 0 }
    }
    return { rows: res.rows ?? [], rowCount: res.rowCount ?? (res.rows ?? []).length }
  }
  const db = await getPglite()
  const res = await db.query(sql, params)
  return { rows: res.rows ?? [], rowCount: res.affectedTuples ?? res.rows?.length ?? 0 }
}

/**
 * A bounded readiness check: one trivial query, reported as a class of failure rather than a
 * driver message.
 *
 * The timeout is the point of the function. A health endpoint that waits for a database that is
 * hanging is indistinguishable from a dead process, and the driver's own message can carry the
 * host and database name, which a public endpoint must never print. So this maps every outcome to
 * `ok`, a duration, and one of three classes: `timeout`, `unreachable`, `error`.
 */
export type DbProbe = { ok: boolean; ms: number; error?: 'timeout' | 'unreachable' | 'error' }

const PROBE_TIMEOUT = Symbol('probe_timeout')

export async function probe(timeoutMs = 2000): Promise<DbProbe> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      query('SELECT 1 AS ok'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(PROBE_TIMEOUT), timeoutMs)
      }),
    ])
    return { ok: true, ms: Date.now() - started }
  } catch (e: any) {
    const code = String(e?.code ?? '')
    const error: DbProbe['error'] =
      e === PROBE_TIMEOUT
        ? 'timeout'
        : /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/.test(code) || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(String(e?.message ?? ''))
          ? 'unreachable'
          : 'error'
    return { ok: false, ms: Date.now() - started, error }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function one(sql: string, params: any[] = []): Promise<any | null> {
  const r = await query(sql, params)
  return r.rows[0] ?? null
}

/** Run fn inside a transaction. q(sql, params) uses the same connection. */
export async function tx<T>(fn: (q: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
  if (env.databaseUrl) {
    const pool = await getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const q = (sql: string, params: any[] = []) => client.query(sql, params)
      const out = await fn(q as any)
      await client.query('COMMIT')
      return out
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }
  const db = await getPglite()
  return await db.transaction(async (tdb: any) => {
    const q = (sql: string, params: any[] = []) => tdb.query(sql, params)
    return fn(q as any)
  })
}

let migrated = false

export async function migrate(): Promise<void> {
  if (migrated) return
  const schema = (await import('node:fs')).readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
  if (env.databaseUrl) {
    await query(schema) // pg simple-query protocol allows multi-statement when unparameterized
  } else {
    const db = await getPglite()
    await db.exec(schema)
  }
  migrated = true
}
