/**
 * Exact conversion of raw token units.
 *
 * `Number(raw)` on an 18-decimal amount loses precision past 2^53 raw units, so the raw figure is
 * converted through BigInt first and every digit survives that step.
 *
 * What this module does NOT guarantee is an exact dollar figure. `rawAmountToNumber` returns a
 * token-scale float and callers multiply it by an oracle price that is itself a float, so the USD
 * valuation is a float estimate (rounding, not truncation, at the last step), while the ledger keeps
 * integer micro-dollars. Read the header as "no digit is lost converting the raw amount", not as
 * "the arithmetic downstream is exact".
 */

const MAX_DECIMALS = 36

export function formatRawAmount(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`Unsupported token decimals: ${decimals}`)
  }
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const fraction = abs % base
  // Trailing zeros carry no information, so "1000.000000000000000000" prints as "1000".
  const fractionText =
    decimals === 0 ? '' : fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole.toString()}${fractionText ? `.${fractionText}` : ''}`
}

/** Token amount as a JS number, via the exact decimal string rather than the raw integer. */
export function rawAmountToNumber(raw: bigint, decimals: number): number {
  return Number(formatRawAmount(raw, decimals))
}
