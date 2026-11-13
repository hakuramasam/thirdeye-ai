import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bpsOf,
  blockedBy,
  distributionGuards,
  levelFor,
  splitProfit,
  usdToMicros,
  microsToUsd,
} from '../src/lib/profit.js'

test('bpsOf floors and ignores non-positive input', () => {
  assert.equal(bpsOf(usdToMicros(1000), 200), usdToMicros(20))
  assert.equal(bpsOf(0, 200), 0)
  assert.equal(bpsOf(-5, 200), 0)
  assert.equal(bpsOf(333, 3), 0) // 0.0999 micros floors to nothing rather than over-paying
})

test('levelFor walks the ramp and never goes below level 1', () => {
  assert.equal(levelFor(0).level, 1)
  assert.equal(levelFor(usdToMicros(999)).level, 1)
  assert.equal(levelFor(usdToMicros(1_000)).level, 2)
  assert.equal(levelFor(usdToMicros(4_999)).level, 2)
  assert.equal(levelFor(usdToMicros(5_000)).level, 3)
  assert.equal(levelFor(usdToMicros(20_000)).level, 4)
  assert.equal(levelFor(usdToMicros(50_000)).level, 5)
  assert.equal(levelFor(usdToMicros(500_000)).level, 5)
  assert.equal(levelFor(-usdToMicros(10)).level, 1)
})

test('the $1000 example from the policy splits exactly as documented', () => {
  const result = splitProfit(usdToMicros(1000), { founderBps: 200, teamAgentIds: Array.from({ length: 12 }, (_, i) => `a${i}`) })
  assert.equal(microsToUsd(result.founder_total_usd_micros), 128) // 20 direct + 108 swept from the twelve
  assert.equal(microsToUsd(result.vault_usd_micros), 850)
  assert.equal(microsToUsd(result.team_retained_usd_micros), 12) // each agent keeps $1 of its $10

  const founder = result.lines.find((l) => l.recipient_kind === 'founder')
  assert.equal(microsToUsd(founder!.amount_usd_micros), 20)

  const elio = result.lines.find((l) => l.recipient_kind === 'platform_agent')
  assert.equal(microsToUsd(elio!.amount_usd_micros), 10)

  const agents = result.lines.filter((l) => l.recipient_kind === 'team_agent')
  assert.equal(agents.length, 12)
  for (const agent of agents) {
    assert.equal(microsToUsd(agent.amount_usd_micros), 10)
    assert.equal(microsToUsd(agent.swept_usd_micros), 9)
  }
  assert.equal(result.checksum_usd_micros, usdToMicros(1000))
})

test('at level 5 the founder takes more and the vault takes less', () => {
  const result = splitProfit(usdToMicros(1000), { founderBps: 500, teamAgentIds: Array.from({ length: 12 }, (_, i) => `a${i}`) })
  assert.equal(microsToUsd(result.founder_total_usd_micros), 158) // 50 direct + 108 swept
  assert.equal(microsToUsd(result.vault_usd_micros), 820)
  assert.equal(result.checksum_usd_micros, usdToMicros(1000))
})

test('rounding dust stays in the vault and the lines always reconcile', () => {
  for (const profit of [1, 7, 999, 12_345, usdToMicros(3.33)]) {
    const result = splitProfit(profit, { founderBps: 200, teamAgentIds: ['a', 'b', 'c'] })
    assert.equal(result.checksum_usd_micros, profit, `lines must sum to the profit for ${profit}`)
    assert.ok(result.vault_usd_micros >= 0)
    assert.ok(result.lines.every((l) => Number.isInteger(l.amount_usd_micros)))
  }
})

test('a period with no profit produces no lines at all', () => {
  const result = splitProfit(0)
  assert.deepEqual(result.lines, [])
  assert.equal(result.vault_usd_micros, 0)
  assert.equal(result.founder_total_usd_micros, 0)
})

test('guards block a distribution with no profit, thin reserves or unbacked credit', () => {
  const noProfit = distributionGuards({
    profit_usd_micros: 0,
    vault_stable_usd_micros: usdToMicros(10_000),
    outstanding_credit_usd_micros: 0,
  })
  assert.ok(blockedBy(noProfit))
  assert.ok(noProfit.some((g) => g.code === 'no_realised_profit'))

  const thinVault = distributionGuards({
    profit_usd_micros: usdToMicros(100),
    vault_stable_usd_micros: usdToMicros(100),
    outstanding_credit_usd_micros: 0,
  })
  assert.ok(thinVault.some((g) => g.code === 'below_reserve_floor'))

  const unbacked = distributionGuards({
    profit_usd_micros: usdToMicros(100),
    vault_stable_usd_micros: usdToMicros(2_000),
    outstanding_credit_usd_micros: usdToMicros(5_000),
  })
  assert.ok(unbacked.some((g) => g.code === 'backing_below_liability'))
  assert.ok(blockedBy(unbacked))
})

test('a healthy period clears every guard', () => {
  const guards = distributionGuards({
    profit_usd_micros: usdToMicros(2_000),
    vault_stable_usd_micros: usdToMicros(10_000),
    outstanding_credit_usd_micros: usdToMicros(500),
    opex_usd_micros: usdToMicros(100),
  })
  assert.equal(blockedBy(guards), false, JSON.stringify(guards))
})
