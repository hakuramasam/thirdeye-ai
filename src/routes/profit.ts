/**
 * Profit reporting. Read-only by design.
 *
 * GET  /api/admin/profit/preview   compute a period from the database, send nothing
 * POST /api/admin/profit/period    store that computation as a draft period plus planned lines
 * GET  /api/admin/profit/periods   list stored periods with their lines
 *
 * Nothing here signs or submits a transfer. A stored period records what was measured so the
 * same numbers can be re-derived and audited later, which is the whole reason it is not a
 * spreadsheet.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../lib/types.js'
import { randomUUID } from 'node:crypto'
import { env } from '../lib/env.js'
import { one, query } from '../db/index.js'
import {
  blockedBy,
  distributionGuards,
  levelFor,
  measurePeriod,
  microsToUsd,
  splitProfit,
  teamAgents,
  trailingProfitMicros,
  usdToMicros,
} from '../lib/profit.js'

const RECIPIENTS = {
  founder: process.env.FOUNDER_WALLET || '0x1cecdfbb8507800e34e07dd4723abdf8ea07c747',
  platform_agent: process.env.PLATFORM_AGENT_KEY_WALLET || '0x9e506B32A1e7616AecA2924cd7E83f170f7d1b7a',
  vault: process.env.PLATFORM_RECEIVER_ADDRESS || '0x73fAf95B2Baa23bde4CE8547b64C55159022Cf0d',
}

function defaultWindow(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1))
  return { from: from.toISOString(), to: to.toISOString() }
}

async function buildReport(from: string, to: string, opts: { gasUsd?: number; infraUsd?: number; vaultUsdMicros?: number }) {
  const measured = await measurePeriod(from, to, {
    gasCostUsdMicros: opts.gasUsd != null ? usdToMicros(opts.gasUsd) : 0,
    infraCostUsdMicros: opts.infraUsd != null ? usdToMicros(opts.infraUsd) : 0,
  })

  const trailing = await trailingProfitMicros(90)
  const level = levelFor(trailing)
  const agents = await teamAgents()

  const split = splitProfit(measured.profit_usd_micros, {
    founderBps: level.founderBps,
    config: { platformAgentBps: 100, perTeamAgentBps: 100, teamAgentCount: agents.length || 12, agentRetainBps: 1_000 },
    teamAgentIds: agents.length ? agents.map((a) => a.id) : undefined,
  })

  const walletFor = (kind: string, ref: string | null): string | null => {
    if (kind === 'founder') return RECIPIENTS.founder
    if (kind === 'platform_agent') return RECIPIENTS.platform_agent
    if (kind === 'vault') return RECIPIENTS.vault
    return null // team agents have no wallets yet, so their line is not payable
  }

  const lines = split.lines.map((line) => ({
    ...line,
    recipient_name:
      line.recipient_kind === 'team_agent'
        ? agents.find((a) => a.id === line.recipient_ref)?.name ?? line.recipient_ref
        : line.recipient_ref,
    wallet_address: walletFor(line.recipient_kind, line.recipient_ref),
    payable: walletFor(line.recipient_kind, line.recipient_ref) !== null,
  }))

  const guards = distributionGuards({
    profit_usd_micros: measured.profit_usd_micros,
    vault_stable_usd_micros: opts.vaultUsdMicros ?? 0,
    outstanding_credit_usd_micros: measured.outstanding_credit_usd_micros,
  })
  if (opts.vaultUsdMicros == null) {
    guards.push({
      code: 'vault_balance_unverified',
      blocks: false,
      detail: 'No vault balance supplied, so reserve and liability checks could not run. Pass vault_usd to include them.',
    })
  }

  return {
    read_only: true,
    moves_money: false,
    period: { from, to },
    measured: {
      ...measured,
      revenue_usd: microsToUsd(measured.revenue_usd_micros),
      provider_cost_usd: microsToUsd(measured.provider_cost_usd_micros),
      cost_usd: microsToUsd(measured.cost_usd_micros),
      profit_usd: microsToUsd(measured.profit_usd_micros),
      outstanding_credit_usd: microsToUsd(measured.outstanding_credit_usd_micros),
    },
    level: {
      applied: level.level,
      founder_bps: level.founderBps,
      trailing_90d_profit_usd: microsToUsd(trailing),
      next_threshold_usd: level.level < 5 ? microsToUsd([0, 1_000, 5_000, 20_000, 50_000][level.level] ?? 0) : null,
    },
    split: {
      ...split,
      founder_total_usd: microsToUsd(split.founder_total_usd_micros),
      vault_usd: microsToUsd(split.vault_usd_micros),
      team_retained_usd: microsToUsd(split.team_retained_usd_micros),
      profit_usd: microsToUsd(split.profit_usd_micros),
      lines: lines.map((l) => ({
        ...l,
        amount_usd: microsToUsd(l.amount_usd_micros),
        swept_usd: microsToUsd(l.swept_usd_micros),
      })),
    },
    guards,
    distributable: !blockedBy(guards),
    notes: [
      'Revenue is billed consumption only. Deposits are liabilities and are reported separately as outstanding credit.',
      'Provider cost is derived as billed / (1 + PLATFORM_MARGIN_PCT). If the margin changed mid-period the figure drifts.',
      'Gas and infra are zero unless passed explicitly, because neither is recorded per transaction yet.',
      'Team agent lines show payable:false until those wallets exist.',
    ],
  }
}

export function registerProfitRoutes(app: Hono<AppEnv>): void {
  const requireMaster = (c: any) =>
    c.req.header('x-master-key') === env.masterKey ? null : c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)

  app.get('/api/admin/profit/preview', async (c) => {
    const denied = requireMaster(c)
    if (denied) return denied

    const now = defaultWindow()
    const from = c.req.query('from') || now.from
    const to = c.req.query('to') || now.to
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return c.json({ error: { message: 'from and to must be ISO timestamps', type: 'validation', code: 400 } }, 400)
    }
    if (Date.parse(from) >= Date.parse(to)) {
      return c.json({ error: { message: 'from must be before to', type: 'validation', code: 400 } }, 400)
    }

    const gasUsd = c.req.query('gas_usd') ? Number(c.req.query('gas_usd')) : undefined
    const infraUsd = c.req.query('infra_usd') ? Number(c.req.query('infra_usd')) : undefined
    const vaultUsd = c.req.query('vault_usd') ? usdToMicros(Number(c.req.query('vault_usd'))) : undefined

    const report = await buildReport(from, to, { gasUsd, infraUsd, vaultUsdMicros: vaultUsd })
    return c.json(report)
  })

  app.post('/api/admin/profit/period', async (c) => {
    const denied = requireMaster(c)
    if (denied) return denied

    const body = (await c.req.json().catch(() => ({}))) as {
      from?: string
      to?: string
      gas_usd?: number
      infra_usd?: number
      vault_usd?: number
      notes?: string
    }
    const now = defaultWindow()
    const from = body.from || now.from
    const to = body.to || now.to
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) {
      return c.json({ error: { message: 'from and to must be valid ISO timestamps in order', type: 'validation', code: 400 } }, 400)
    }

    const existing = await one(`SELECT id, status FROM profit_periods WHERE period_start = $1 AND period_end = $2`, [from, to])
    if (existing) {
      const stored = await query(`SELECT * FROM profit_distributions WHERE period_id = $1 ORDER BY id`, [existing.id])
      return c.json({ created: false, period_id: existing.id, status: existing.status, distributions: stored.rows })
    }

    const report = await buildReport(from, to, {
      gasUsd: body.gas_usd,
      infraUsd: body.infra_usd,
      vaultUsdMicros: body.vault_usd != null ? usdToMicros(body.vault_usd) : undefined,
    })

    const id = randomUUID()
    await query(
      `INSERT INTO profit_periods
         (id, period_start, period_end, revenue_usd_micros, provider_cost_usd_micros,
          gas_cost_usd_micros, infra_cost_usd_micros, profit_usd_micros, level, founder_bps, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft','agent')`,
      [
        id,
        from,
        to,
        report.measured.revenue_usd_micros,
        report.measured.provider_cost_usd_micros,
        report.measured.gas_cost_usd_micros,
        report.measured.infra_cost_usd_micros,
        report.measured.profit_usd_micros,
        report.level.applied,
        report.level.founder_bps,
        body.notes ?? null,
      ]
    )

    for (const line of report.split.lines) {
      await query(
        `INSERT INTO profit_distributions
           (period_id, recipient_kind, recipient_ref, wallet_address, bps, amount_usd_micros, swept_usd_micros, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'planned')`,
        [id, line.recipient_kind, line.recipient_ref, line.wallet_address, line.bps, line.amount_usd_micros, line.swept_usd_micros]
      )
    }

    return c.json({
      created: true,
      period_id: id,
      status: 'draft',
      moves_money: false,
      profit_usd: report.split.profit_usd,
      founder_total_usd: report.split.founder_total_usd,
      vault_usd: report.split.vault_usd,
      distributable: report.distributable,
      guards: report.guards,
      lines: report.split.lines.length,
    })
  })

  app.get('/api/admin/profit/periods', async (c) => {
    const denied = requireMaster(c)
    if (denied) return denied

    const periods = await query(
      `SELECT id, period_start, period_end, revenue_usd_micros, provider_cost_usd_micros, gas_cost_usd_micros,
              infra_cost_usd_micros, profit_usd_micros, level, founder_bps, status, created_at
         FROM profit_periods ORDER BY period_start DESC LIMIT 24`
    )
    const rows = []
    for (const period of periods.rows ?? []) {
      const lines = await query(`SELECT recipient_kind, recipient_ref, amount_usd_micros, swept_usd_micros, status, tx_hash FROM profit_distributions WHERE period_id = $1 ORDER BY id`, [period.id])
      rows.push({
        ...period,
        revenue_usd: microsToUsd(Number(period.revenue_usd_micros)),
        profit_usd: microsToUsd(Number(period.profit_usd_micros)),
        distributions: (lines.rows ?? []).map((l: any) => ({
          ...l,
          amount_usd: microsToUsd(Number(l.amount_usd_micros)),
          swept_usd: microsToUsd(Number(l.swept_usd_micros)),
        })),
      })
    }
    return c.json({ periods: rows })
  })
}
