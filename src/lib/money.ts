/**
 * Exact conversion of raw token units.
 *
 * `Number(raw)` on an 18-decimal amount loses precision past 2^53 raw units, which is a fraction of
 * a cent for most tokens but truncates large balances and rounds in the wrong direction on the way
 * into a USD valuation. Formatting through BigInt first keeps every digit, and only the final
 * dollar-scale number is a float, where the float is unavoidable because oracle prices are floats.
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
