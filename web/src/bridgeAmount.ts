/**
 * Amount helpers for the cross-chain deposit panel, kept out of the component so they can be tested
 * without a DOM. Both work in integer space: a user-typed decimal never passes through a float.
 */

/** Raw 6-decimal units from a typed amount, or null when the input is not a usable amount. */
export function toRawUnits(input: string): string | null {
  const t = input.trim()
  if (!/^\d{0,12}(\.\d{0,6})?$/.test(t) || t === '' || t === '.') return null
  const [whole, frac = ''] = t.split('.')
  const raw = ((whole || '0') + (frac + '000000').slice(0, 6)).replace(/^0+(?=\d)/, '')
  return /^0+$/.test(raw) ? null : raw
}

/** Display 6-decimal raw units as a two-place decimal, without dividing a float. */
export function fmtUsdc(raw: string): string {
  let b: bigint
  try { b = BigInt(raw) } catch { return '0.00' }
  return `${b / 1000000n}.${((b % 1000000n).toString().padStart(6, '0')).slice(0, 2)}`
}
