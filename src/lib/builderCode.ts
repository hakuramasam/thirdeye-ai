/**
 * ERC-8021 attribution suffix (Base Builder Codes).
 *
 * A builder code is a short identifier appended to calldata. Contracts ignore it; offchain indexers
 * extract it after the fact, which is what makes an agent's onchain activity attributable at all.
 * Cost is 16 gas per non-zero byte, so the suffix is cheap and costs nothing to anyone reading the tx.
 *
 * Two rules govern this module, because every caller is a money path:
 *   1. Attribution must never be able to fail a transaction. Any encoding problem returns the calldata
 *      unchanged rather than throwing, and a malformed code is ignored rather than passed through.
 *   2. A bare transfer is left alone: empty calldata plus a suffix is not equivalent to empty calldata.
 *   3. Appending twice must be impossible. A retry that reuses already-attributed calldata would pay
 *      for a second suffix and, worse, put two codes in one transaction.
 */

import { Attribution } from 'ox/erc8021'

/** Registered with base.dev for wallet 0x73f1…487b and nominated by the operator for all agent sends. */
export const DEFAULT_BUILDER_CODE = 'bc_qt11jd66'

/** Schema 0 trailer: the 16 bytes that mark a calldata as carrying an ERC-8021 suffix. */
export const ERC8021_TRAILER = '80218021802180218021802180218021'

/** `bc_` followed by eight lowercase alphanumerics, which is the shape base.dev returns. */
const CODE_PATTERN = /^bc_[a-z0-9]{8}$/

/**
 * The code to attribute with, or null when attribution is switched off or the configured value is not
 * a builder code at all. An empty BUILDER_CODE disables attribution deliberately.
 */
export function builderCodeFrom(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.BUILDER_CODE ?? DEFAULT_BUILDER_CODE).trim()
  if (raw === '') return null
  return CODE_PATTERN.test(raw) ? raw : null
}

/** True when calldata already ends in the ERC-8021 trailer, whatever code it carries. */
export function hasAttribution(data: string | undefined): boolean {
  if (!data) return false
  return data.toLowerCase().endsWith(ERC8021_TRAILER)
}

/**
 * Append the attribution suffix to calldata. Idempotent, and never throws: a payment that cannot be
 * attributed is still a payment, so the calldata goes out unchanged rather than being dropped.
 */
export function withAttribution(
  data: `0x${string}` | undefined,
  env: NodeJS.ProcessEnv = process.env,
): `0x${string}` | undefined {
  const code = builderCodeFrom(env)
  if (!code) return data
  if (hasAttribution(data)) return data
  // A bare value transfer carries no calldata to extend, and adding some would make it revert against
  // a contract whose fallback is absent or non-payable. Attribution applies to calls, not to sends.
  if (!data || data === '0x') return data
  try {
    const suffix = Attribution.toDataSuffix({ codes: [code] })
    return `${data}${suffix.slice(2)}` as `0x${string}`
  } catch {
    return data
  }
}
