#!/usr/bin/env node
/**
 * Balance sweep for Thirdeye.
 *
 * Reads the production ledger and reports accounts whose prepaid credit is
 * running out: trailing 7-day burn, implied daily burn, and runway in days.
 * An account is flagged when it has real burn AND either
 *   - runway is under RUNWAY_DAYS (default 3), or
 *   - the remaining balance is under MIN_BALANCE_MICROS (default $1).
 *
 * Usage: node scripts/balance-sweep.mjs [--json] [--force]
 *   --json   machine-readable output only
 *   --force  ignore the once-per-day de-duplication state
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const STATE_FILE = path.join(HERE, '.balance-alerts.json')

const RUNWAY_DAYS = Number(process.env.SWEEP_RUNWAY_DAYS ?? 3)
const MIN_BALANCE_MICROS = Number(process.env.SWEEP_MIN_BALANCE_MICROS ?? 1_000_000)
const JSON_ONLY = process.argv.includes('--json')
const FORCE = process.argv.includes('--force')

function readDatabaseUrl() {
  // The sandbox sometimes exposes a truncated DATABASE_URL (hostname only).
  const fromEnv = process.env.DATABASE_URL || ''
  if (/^postgres(ql)?:\/\//.test(fromEnv)) return fromEnv
  const envPath = path.join(ROOT, '.env.production.local')
  if (!fs.existsSync(envPath)) throw new Error('DATABASE_URL not set and .env.production.local missing')
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))
  if (!line) throw new Error('DATABASE_URL not found in .env.production.local')
  return line.slice('DATABASE_URL='.length).trim().replace(/^['"]|['"]$/g, '')
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

const { neon } = await import('@neondatabase/serverless')
const sql = neon(readDatabaseUrl())

const rows = await sql`
  WITH spend AS (
    SELECT user_id, COALESCE(SUM(-amount_usd_micros), 0)::bigint AS spent_7d
    FROM ledger
    WHERE kind = 'usage' AND created_at > now() - interval '7 days'
    GROUP BY user_id
  ), last_seen AS (
    SELECT user_id, MAX(created_at) AS last_activity FROM ledger GROUP BY user_id
  )
  SELECT u.id,
         u.wallet,
         COALESCE((SELECT SUM(amount_usd_micros) FROM ledger l WHERE l.user_id = u.id), 0)::bigint AS balance,
         COALESCE(s.spent_7d, 0)::bigint AS spent_7d,
         ls.last_activity
  FROM users u
  LEFT JOIN spend s ON s.user_id = u.id
  LEFT JOIN last_seen ls ON ls.user_id = u.id
  ORDER BY balance ASC`

const today = new Date().toISOString().slice(0, 10)
const state = readState()
const alerts = []
const observations = []

for (const r of rows) {
  const balance = Number(r.balance)
  const spent7 = Number(r.spent_7d)
  const dailyBurn = spent7 / 7
  const runwayDays = dailyBurn > 0 ? balance / dailyBurn : null
  const short = r.wallet ? `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}` : r.id

  const lowRunway = runwayDays != null && runwayDays < RUNWAY_DAYS
  const lowBalance = spent7 > 0 && balance < MIN_BALANCE_MICROS
  const shouldAlert = spent7 > 0 && (lowRunway || lowBalance)

  const entry = {
    wallet: r.wallet,
    short,
    balance_usd: balance / 1e6,
    spent_7d_usd: spent7 / 1e6,
    daily_burn_usd: dailyBurn / 1e6,
    runway_days: runwayDays == null ? null : Math.round(runwayDays * 10) / 10,
    last_activity: r.last_activity,
    alert: shouldAlert,
  }

  if (shouldAlert) {
    const already = state[r.wallet] === today && !FORCE
    if (!already) {
      alerts.push(entry)
      state[r.wallet] = today
    }
  }
  observations.push(entry)
}

writeState(state)

const out = {
  generated_at: new Date().toISOString(),
  accounts: observations.length,
  alerts,
  thresholds: { runway_days: RUNWAY_DAYS, min_balance_usd: MIN_BALANCE_MICROS / 1e6 },
}

if (JSON_ONLY) {
  console.log(JSON.stringify(out))
} else {
  if (alerts.length === 0) {
    console.log(`Balance sweep: ${observations.length} account(s), nothing running low.`)
    for (const o of observations) {
      console.log(
        `  ${o.short}  balance $${o.balance_usd.toFixed(4)}  burn $${o.daily_burn_usd.toFixed(6)}/day  runway ${o.runway_days ?? 'n/a'}d`
      )
    }
  } else {
    console.log(`Balance sweep: ${alerts.length} account(s) running low.`)
    for (const a of alerts) {
      console.log(
        `  ${a.short}  balance $${a.balance_usd.toFixed(4)}  burn $${a.daily_burn_usd.toFixed(6)}/day  runway ${a.runway_days ?? 'n/a'}d`
      )
    }
  }
}
