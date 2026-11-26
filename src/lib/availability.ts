/**
 * Which catalogue models can actually be served right now, and what to tell a caller when one
 * cannot be.
 *
 * The defect this closes: the catalogue lists every model we have priced, while only the
 * providers we hold a platform key for can be served on platform credit. A caller that reads
 * the list, picks a name and gets a refusal has no way to tell "add your own key" from "pick a
 * different model", so it guesses, and the guess it reports back is that the platform is
 * unusable. Availability is therefore computed from the same key lookup the provider resolver
 * uses, never from a hardcoded list that drifts from it.
 *
 * Everything here is pure: no database, no environment import. The rules can be tested without
 * a database and cannot quietly disagree with the money path they describe.
 */

import type { ModelRow } from './pricing.js'

export type ProviderKeys = Record<string, string>

/** providers that do not resolve their name from a base URL hostname */
const NATIVE_PROVIDERS = new Set(['openai', 'anthropic', 'mock'])

/** A provider name reduced to the characters an environment variable name can hold. */
function envSafe(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Provider name for a catalogue row, in the exact form `PROV_<NAME>_API_KEY` is built from.
 *
 * Hostnames are reduced to their first label after stripping `api.`, because the key loader
 * only accepts `[A-Z0-9]` between `PROV_` and `_API_KEY`. An earlier version stripped only the
 * TLD, so a host like `generativelanguage.googleapis.com` produced the dotted name
 * `generativelanguage.googleapis`, which no environment variable can ever match, and the
 * provider looked unfunded even with a key correctly set. Groq, Mistral and DeepSeek resolve to
 * the same names as before, so no stored BYOK row changes meaning.
 */
export function providerNameFor(model: Pick<ModelRow, 'provider' | 'base_url'>): string {
  const declared = String(model.provider || '')
    .trim()
    .toLowerCase()
  if (NATIVE_PROVIDERS.has(declared)) return declared

  const base = model.base_url ? String(model.base_url) : ''
  if (!base) return envSafe(declared)

  let host = ''
  try {
    host = new URL(base.startsWith('http') ? base : `https://${base}`).hostname.toLowerCase()
  } catch (_) {
    return envSafe(declared)
  }

  const label = host.replace(/^api\./, '').split('.')[0] || ''
  return envSafe(label) || envSafe(declared)
}

export type Availability = {
  /** the provider whose key decides this, in PROV_<NAME>_API_KEY form */
  provider: string
  /** servable now, on platform credit, with no key from the caller */
  available: boolean
  /** whether the caller could serve it with their own provider key instead */
  byok_supported: boolean
  /** absent when available; a stable token a client can branch on */
  unavailable_reason?: 'no_platform_key' | 'disabled'
}

export function modelAvailability(model: ModelRow, keys: ProviderKeys): Availability {
  const provider = providerNameFor(model)

  if (!model.enabled) {
    return { provider, available: false, byok_supported: false, unavailable_reason: 'disabled' }
  }

  // The mock provider is a local echo with no upstream and no key. It is servable, but it is
  // not a completion, so it is never offered as a substitute for a real model.
  if (provider === 'mock') {
    return { provider, available: true, byok_supported: false }
  }

  const funded = Boolean(keys[provider])
  return funded
    ? { provider, available: true, byok_supported: true }
    : { provider, available: false, byok_supported: true, unavailable_reason: 'no_platform_key' }
}

/** Ids a caller can retry with immediately, cheapest first. Mock excluded. */
export function availableModelIds(models: ModelRow[], keys: ProviderKeys): string[] {
  return models
    .filter((m) => providerNameFor(m) !== 'mock' && modelAvailability(m, keys).available)
    .sort((a, b) => listPriceMicros(a) - listPriceMicros(b) || a.model.localeCompare(b.model))
    .map((m) => m.model)
}

/** Input plus output rate per million, used only to order candidates. */
export function listPriceMicros(model: ModelRow): number {
  return Number(model.price_in_1m_usd_micros) + Number(model.price_out_1m_usd_micros)
}

/** Model ids that mean "whatever is cheapest and actually servable right now". */
export const AUTO_ALIASES = ['auto', 'thirdeye/auto', 'thirdeye-auto', 'thirdeye_auto']

export function isAutoAlias(name: string): boolean {
  return AUTO_ALIASES.includes(String(name || '').trim().toLowerCase())
}

/**
 * Cheapest model servable without the caller's own key, or null when none is.
 *
 * The mock model is excluded deliberately: it is free, so it would win every comparison, and a
 * caller who asked for `auto` would silently receive an echo of their own prompt. Ties break on
 * id, so the same catalogue always produces the same answer, which is what makes this testable
 * and what stops two identical requests from being billed at different rates.
 */
export function cheapestAvailable(models: ModelRow[], keys: ProviderKeys): ModelRow | null {
  const usable = models.filter(
    (m) => providerNameFor(m) !== 'mock' && modelAvailability(m, keys).available
  )
  if (usable.length === 0) return null
  return (
    usable.sort(
      (a, b) => listPriceMicros(a) - listPriceMicros(b) || a.model.localeCompare(b.model)
    )[0] ?? null
  )
}
