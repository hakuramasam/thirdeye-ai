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
    const res = await pool.query(sql, params)
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length }
  }
  const db = await getPglite()
  const res = await db.query(sql, params)
  return { rows: res.rows ?? [], rowCount: res.affectedTuples ?? res.rows?.length ?? 0 }
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
