process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * The sale policy is a document, so the risk is not a broken function: it is an edited number that
 * quietly reopens a free-credit loop or moves the floor. These checks read the recorded table and
 * assert the arithmetic, so a future edit has to be deliberate.
 */
const docPath = fileURLToPath(new URL('../docs/token-sale-policy.md', import.meta.url))
const doc = readFileSync(docPath, 'utf8')

const SUPPLY = 1_000_000_000
/** Deposit credit as shipped: PLATFORM_TOKEN_USD_RATE 0.00008 plus a 1000 bps bonus. */
const CREDIT_RATE_USD = 0.00008
const BONUS_BPS = 1_000
const CREDITED_PER_TOKEN = CREDIT_RATE_USD * (1 + BONUS_BPS / 10_000)

function priceRow(label: string): { usdPerToken: number; fdv: number } {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${label} |`))
  assert.ok(line, `the price table has no "${label}" row`)
  const cells = line.split('|').map((c) => c.trim())
  const usdPerToken = Number(cells[2].replace(/[$,]/g, ''))
  const fdv = Number(cells[3].replace(/[$,]/g, ''))
  assert.ok(
    Number.isFinite(usdPerToken) && Number.isFinite(fdv),
    `the "${label}" row must carry a unit price and an FDV`,
  )
  return { usdPerToken, fdv }
}

test('the hard floor is $50,000 FDV and the recorded price matches it exactly', () => {
  const floor = priceRow('hard floor')
  assert.equal(floor.fdv, 50_000)
  assert.ok(
    Math.abs(floor.usdPerToken * SUPPLY - floor.fdv) < 1e-6,
    `${floor.usdPerToken} per token is not $${floor.fdv} of FDV at ${SUPPLY} supply`,
  )
})

test('the asking price is $88,000 FDV and matches its own price', () => {
  const ask = priceRow('asking price')
  assert.equal(ask.fdv, 88_000)
  assert.ok(
    Math.abs(ask.usdPerToken * SUPPLY - ask.fdv) < 1e-6,
    `${ask.usdPerToken} per token is not $${ask.fdv} of FDV at ${SUPPLY} supply`,
  )
})

test('the asking price does not undercut what a deposited token is credited at', () => {
  const ask = priceRow('asking price')
  // Below the post-bonus credit value, buy-then-deposit returns more credit than the token cost.
  assert.ok(
    ask.usdPerToken >= CREDITED_PER_TOKEN - 1e-12,
    `asking ${ask.usdPerToken} undercuts the ${CREDITED_PER_TOKEN} credit a deposited token earns`,
  )
})

test('the asking price stays above the floor', () => {
  assert.ok(priceRow('asking price').fdv > priceRow('hard floor').fdv)
})

test('sales are permitted now and the waiting period stays deleted', () => {
  assert.match(doc, /Sales are permitted from adoption/)
  assert.match(doc, /"no sales before month six" condition is deleted/)
})
