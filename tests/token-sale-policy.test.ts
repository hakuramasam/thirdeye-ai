process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * The sale policy is a document, so the risk is not a broken function: it is an edited number that
 * quietly reopens a free-credit loop or drops the floor below what was agreed. These checks read the
 * recorded tables and assert the arithmetic between them, so an edit has to be deliberate.
 *
 * The deposit settings are read from the policy's own settings table rather than hardcoded here, so the
 * binding minimum is always compared against the rate and bonus the document claims are live.
 */
const docPath = fileURLToPath(new URL('../docs/token-sale-policy.md', import.meta.url))
const doc = readFileSync(docPath, 'utf8')

const SUPPLY = 1_000_000_000

function cells(line: string): string[] {
  return line.split('|').map((c) => c.trim())
}

function number(cell: string | undefined, what: string): number {
  const value = Number((cell ?? '').replace(/[$,`]/g, ''))
  assert.ok(Number.isFinite(value), `${what} must be a number, got "${cell}"`)
  return value
}

/** A row of the price table: unit price and the FDV it claims. */
function priceRow(label: string): { usdPerToken: number; fdv: number } {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${label} |`))
  assert.ok(line, `the price table has no "${label}" row`)
  const row = cells(line)
  return { usdPerToken: number(row[2], `${label} price`), fdv: number(row[3], `${label} FDV`) }
}

/** A row of the deposit-settings table: the live value and the repository default. */
function settingRow(label: string): { production: number; repoDefault: number } {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${label} |`))
  assert.ok(line, `the settings table has no "${label}" row`)
  const row = cells(line)
  return {
    production: number(row[3], `${label} production value`),
    repoDefault: number(row[4], `${label} repository default`),
  }
}

test('the hard floor is $50,000 FDV and the recorded price matches it exactly', () => {
  const floor = priceRow('hard floor')
  assert.equal(floor.fdv, 50_000)
  assert.ok(
    Math.abs(floor.usdPerToken * SUPPLY - floor.fdv) < 1e-6,
    `${floor.usdPerToken} per token is not $${floor.fdv} of FDV at ${SUPPLY} supply`,
  )
})

test('the binding minimum is at least the documented $88,000 and consistent with its own price', () => {
  const minimum = priceRow('binding minimum, today')
  // A higher minimum than documented stays compliant; a lower one does not.
  assert.ok(minimum.fdv >= 88_000, `the binding minimum dropped to $${minimum.fdv}`)
  // Two-sided: a price that implies a HIGHER FDV than the row states is equally inconsistent, and the
  // earlier one-sided check let exactly that through. Tolerance covers rounding of the printed price
  // (six decimals at 1e9 supply is half a dollar per unit, so $500 is generous and still catches a
  // contradiction like 98,800 against 88,000).
  const tolerance = SUPPLY * 5e-7
  const implied = minimum.usdPerToken * SUPPLY
  assert.ok(
    Math.abs(implied - minimum.fdv) <= tolerance,
    `${minimum.usdPerToken} per token implies $${implied.toFixed(0)} of FDV, not the stated $${minimum.fdv}`,
  )
})

test('no sale price is allowed below what a deposited token is credited at', () => {
  const minimum = priceRow('binding minimum, today')
  const rate = settingRow('policy rate').production
  const bonusBps = settingRow('deposit bonus').production
  const creditedPerToken = rate * (1 + bonusBps / 10_000)
  // Below the post-bonus credit value, buying then depositing returns more credit than the token cost.
  assert.ok(
    minimum.usdPerToken >= creditedPerToken - 1e-12,
    `a $${minimum.usdPerToken} sale undercuts the $${creditedPerToken} credit a deposited token earns`,
  )
})

test('the floor stays below the binding minimum, so the band it forbids is never empty', () => {
  assert.ok(priceRow('binding minimum, today').fdv > priceRow('hard floor').fdv)
})

test('sales are permitted now and the waiting period stays deleted', () => {
  assert.match(doc, /Sales are permitted from adoption/)
  assert.match(doc, /"no sales before month six" condition is deleted/)
})

test('the policy documents the market fallback instead of claiming an unpublished rate is a refusal', () => {
  // The deposit path falls back to a GeckoTerminal read when no policy rate is published, so the
  // claim that an unset rate refuses valuation was wrong and must not come back.
  assert.match(doc, /GeckoTerminal/)
  assert.match(doc, /PLATFORM_TOKEN_MIN_LIQUIDITY_USD/)
  assert.doesNotMatch(doc, /refuses to value the token at all/)
})

test('the superseded launch shapes are named, so a sale decision has one source of truth', () => {
  for (const stale of ['50,000,000', '250,000,000', '700,000,000']) {
    assert.ok(doc.includes(stale), `the policy no longer names the superseded ${stale} figure`)
  }
  const plan = readFileSync(fileURLToPath(new URL('../docs/token-launch-plan.md', import.meta.url)), 'utf8')
  assert.match(plan, /superseded by the live launch/)
})
