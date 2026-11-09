/**
 * Profit accounting and the split defined in docs/profit-split.md.
 *
 * Two rules shape everything here.
 *
 * Customer deposits are liabilities, not income. Only billed consumption minus what it cost
 * us to serve it becomes divisible profit, so this module never treats a deposit as revenue;
 * it only reports the outstanding credit those deposits back.
 *
 * Nothing here moves money. It computes what a period earned, what the split says each
 * recipient would receive, and which guardrails would block a distribution. Sending is a
 * separate, signed step.
 */

import { one, query } from '../db/index.js'

export const BPS_DENOMINATOR = 10_000
export const MICROS_PER_USD = 1_000_000

/** Basis points of a micros amount, rounded down so rounding never over-pays. */
export function bpsOf(amountMicros: number, bps: number): number {
  if (!Number.isFinite(amountMicros) || amountMicros <= 0) return 0
  return Math.floor((amountMicros * bps) / BPS_DENOMINATOR)
}

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD)
}

export function microsToUsd(micros: number): number {
  return Number((micros / MICROS_PER_USD).toFixed(6))
}

/**
 * Founder share ramp. Thresholds are trailing realised profit in micros. The vault takes
 * whatever is left, so raising the founder share lowers the vault share automatically.
 */
export type ProfitLevel = { level: number; founderBps: number; thresholdMicros: number }

export const PROFIT_LEVELS: ProfitLevel[] = [
  { level: 1, founderBps: 200, thresholdMicros: 0 },
  { level: 2, founderBps: 250, thresholdMicros: usdToMicros(1_000) },
  { level: 3, founderBps: 300, thresholdMicros: usdToMicros(5_000) },
  { level: 4, founderBps: 400, thresholdMicros: usdToMicros(20_000) },
  { level: 5, founderBps: 500, thresholdMicros: usdToMicros(50_000) },
]

/** Highest level whose threshold the trailing profit clears. Never null. */
export function levelFor(trailingProfitMicros: number): ProfitLevel {
  let chosen = PROFIT_LEVELS[0]
  for (const candidate of PROFIT_LEVELS) {
    if (trailingProfitMicros >= candidate.thresholdMicros) chosen = candidate
  }
  return { ...chosen }
}

export type SplitConfig = {
  platformAgentBps: number
  perTeamAgentBps: number
  teamAgentCount: number
  /** Share of an agent's own slice that stays in its wallet; the rest sweeps to the founder. */
  agentRetainBps: number
}

export const DEFAULT_SPLIT: SplitConfig = {
  platformAgentBps: 100,
  perTeamAgentBps: 100,
  teamAgentCount: 12,
  agentRetainBps: 1_000,
}

export type SplitLine = {
  recipient_kind: 'founder' | 'platform_agent' | 'team_agent' | 'vault'
  recipient_ref: string | null
  bps: number
  amount_usd_micros: number
  /** Team agents only: the portion that sweeps to the founder wallet. */
  swept_usd_micros: number
}

export type SplitResult = {
  level: number
  founderBps: number
  profit_usd_micros: number
  lines: SplitLine[]
  founder_total_usd_micros: number
  vault_usd_micros: number
  team_retained_usd_micros: number
  /** Every line must add back to the profit. Dust lands in the vault. */
  checksum_usd_micros: number
}

/**
 * Split a realised profit figure. Everything left after the founder, the platform agent and
 * the team stays in the treasury vault, including rounding dust.
 */
export function splitProfit(
  profitUsdMicros: number,
  opts: { founderBps?: number; config?: SplitConfig; teamAgentIds?: string[] } = {}
): SplitResult {
  const config = opts.config ?? DEFAULT_SPLIT
  const founderBps = opts.founderBps ?? PROFIT_LEVELS[0].founderBps
  const profit = Math.max(0, Math.floor(profitUsdMicros))
  const teamIds = opts.teamAgentIds ?? Array.from({ length: config.teamAgentCount }, (_, i) => `team_agent_${i + 1}`)

  if (profit === 0) {
    return {
      level: 1,
      founderBps,
      profit_usd_micros: 0,
      lines: [],
      founder_total_usd_micros: 0,
      vault_usd_micros: 0,
      team_retained_usd_micros: 0,
      checksum_usd_micros: 0,
    }
  }

  const lines: SplitLine[] = []

  const founderDirect = bpsOf(profit, founderBps)
  lines.push({ recipient_kind: 'founder', recipient_ref: 'founder', bps: founderBps, amount_usd_micros: founderDirect, swept_usd_micros: 0 })

  const platformAgent = bpsOf(profit, config.platformAgentBps)
  lines.push({ recipient_kind: 'platform_agent', recipient_ref: 'elio', bps: config.platformAgentBps, amount_usd_micros: platformAgent, swept_usd_micros: 0 })

  let sweptTotal = 0
  let retainedTotal = 0
  for (const id of teamIds) {
    const slice = bpsOf(profit, config.perTeamAgentBps)
    const retained = bpsOf(slice, config.agentRetainBps)
    const swept = slice - retained
    retainedTotal += retained
    sweptTotal += swept
    lines.push({
      recipient_kind: 'team_agent',
      recipient_ref: id,
      bps: config.perTeamAgentBps,
      amount_usd_micros: slice,
      swept_usd_micros: swept,
    })
  }

  const distributed = founderDirect + platformAgent + retainedTotal + sweptTotal
  const vault = Math.max(0, profit - distributed)
  lines.push({ recipient_kind: 'vault', recipient_ref: 'treasury', bps: 0, amount_usd_micros: vault, swept_usd_micros: 0 })

  const total = lines.reduce((sum, line) => sum + line.amount_usd_micros, 0)
  return {
    level: 1,
    founderBps,
    profit_usd_micros: profit,
    lines,
    founder_total_usd_micros: founderDirect + sweptTotal,
    vault_usd_micros: vault,
    team_retained_usd_micros: retainedTotal,
    checksum_usd_micros: total,
  }
}

export type GuardInput = {
  profit_usd_micros: number
  vault_stable_usd_micros: number
  outstanding_credit_usd_micros: number
  opex_usd_micros?: number
  existing_status?: string
}

export type Guard = { code: string; blocks: boolean; detail: string }

export const RESERVE_FLOOR_MIN_USD = 500

/** Guardrails from section 6 of the policy. Any blocking guard means no distribution. */
export function distributionGuards(input: GuardInput): Guard[] {
  const guards: Guard[] = []
  const reserveFloor = Math.max(usdToMicros(RESERVE_FLOOR_MIN_USD), 6 * (input.opex_usd_micros ?? 0))

  if (input.profit_usd_micros <= 0) {
    guards.push({ code: 'no_realised_profit', blocks: true, detail: 'The period has no positive realised profit, so there is nothing to split.' })
  }
  if (input.vault_stable_usd_micros < reserveFloor) {
    guards.push({
      code: 'below_reserve_floor',
      blocks: true,
      detail: `Vault stablecoin is below the reserve floor of $${microsToUsd(reserveFloor)}.`,
    })
  }
  if (input.vault_stable_usd_micros < input.outstanding_credit_usd_micros) {
    guards.push({
      code: 'backing_below_liability',
      blocks: true,
      detail: 'Vault stablecoin does not cover outstanding prepaid credit, so it holds customer money rather than profit.',
    })
  }
  if (input.existing_status === 'distributed') {
    guards.push({ code: 'already_distributed', blocks: true, detail: 'This period is already marked distributed.' })
  }
  return guards
}

export function blockedBy(guards: Guard[]): boolean {
  return guards.some((g) => g.blocks)
}

export type PeriodMeasurement = {
  period_start: string
  period_end: string
  revenue_chat_usd_micros: number
  revenue_agent_runs_usd_micros: number
  revenue_usd_micros: number
  provider_cost_usd_micros: number
  gas_cost_usd_micros: number
  infra_cost_usd_micros: number
  cost_usd_micros: number
  profit_usd_micros: number
  outstanding_credit_usd_micros: number
}

/**
 * Measure a period from the database.
 *
 * Revenue is what we actually billed. Provider cost is derived from the billing formula
 * itself: billed = base x (1 + margin), so base = billed / (1 + margin). That is exact while
 * the margin is unchanged and drifts if PLATFORM_MARGIN_PCT is edited, which is why the
 * caller is told which margin was used. BYOK calls bill at a token rate but the user supplies
 * the provider key, so their provider cost to us is zero and they count as margin.
 */
export async function measurePeriod(
  from: string,
  to: string,
  opts: { marginPct?: number; gasCostUsdMicros?: number; infraCostUsdMicros?: number } = {}
): Promise<PeriodMeasurement> {
  const marginPct = opts.marginPct ?? Number(process.env.PLATFORM_MARGIN_PCT || 10)

  const chat = await one(
    `SELECT coalesce(sum(cost_usd_micros), 0)::bigint AS billed
       FROM usage_events
      WHERE created_at >= $1 AND created_at < $2 AND byok = false`,
    [from, to]
  )
  const runs = await one(
    `SELECT coalesce(sum(spend_usd_micros), 0)::bigint AS billed
       FROM agent_runs
      WHERE created_at >= $1 AND created_at < $2 AND spend_usd_micros > 0`,
    [from, to]
  )
  const liability = await one(`SELECT coalesce(-sum(amount_usd_micros), 0)::bigint AS credit FROM ledger`)
  const keyCredit = await one(`SELECT coalesce(sum(credit_usd_micros), 0)::bigint AS credit FROM api_keys`)

  const chatRevenue = Number(chat?.billed ?? 0)
  const runRevenue = Number(runs?.billed ?? 0)
  const revenue = chatRevenue + runRevenue
  const providerCost = Math.round(revenue / (1 + marginPct / 100))
  const gas = Math.max(0, Math.round(opts.gasCostUsdMicros ?? 0))
  const infra = Math.max(0, Math.round(opts.infraCostUsdMicros ?? 0))
  const cost = providerCost + gas + infra
  const outstandingCredit = Math.max(0, Number(liability?.credit ?? 0)) + Math.max(0, Number(keyCredit?.credit ?? 0))

  return {
    period_start: from,
    period_end: to,
    revenue_chat_usd_micros: chatRevenue,
    revenue_agent_runs_usd_micros: runRevenue,
    revenue_usd_micros: revenue,
    provider_cost_usd_micros: providerCost,
    gas_cost_usd_micros: gas,
    infra_cost_usd_micros: infra,
    cost_usd_micros: cost,
    profit_usd_micros: revenue - cost,
    outstanding_credit_usd_micros: outstandingCredit,
  }
}

/** Trailing realised profit, used to pick the ramp level. */
export async function trailingProfitMicros(days: number, marginPct?: number): Promise<number> {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  const measured = await measurePeriod(from.toISOString(), to.toISOString(), { marginPct })
  return measured.profit_usd_micros
}

/** Team agents, so the report names real agents rather than a hard-coded count. */
export async function teamAgents(): Promise<Array<{ id: string; name: string }>> {
  const res = await query(`SELECT id, name FROM agents WHERE id LIKE 'tdt\\_%' ORDER BY id`)
  return (res.rows ?? []).map((row: any) => ({ id: row.id, name: row.name }))
}
