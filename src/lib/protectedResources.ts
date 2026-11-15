/**
 * Protected-resource classification for every write an agent may propose.
 *
 * The rule this module exists to hold: what a path *is* decides who may change it, and the decision
 * is made at the write boundary rather than in a tool description or a prompt. Before this, the
 * repository writer carried one hand-kept list of money paths, so every other sensitive surface
 * (the credits route, auth, environment, deck configuration, workflows, team policy) was writable by
 * an agent as long as it sat under an allowed prefix.
 *
 * Two deliberate choices:
 *
 *  1. Classification runs on a normalized form of the path, never the raw string. Case folding,
 *     percent-decoding, separator swapping, control-character stripping and dot-segment collapsing
 *     all happen first, because each of those is otherwise a one-character bypass of a path rule.
 *  2. Unknown is not automatically allowed. Anything in a protected class is refused for an agent
 *     actor and names the class, so a refusal is actionable instead of mysterious.
 */

export type ActorType = 'agent' | 'operator' | 'owner'
export type Approver = 'owner' | 'agent'

export type ResourceClass = {
  /** Stable id used in refusals, audit rows and tests. */
  id: string
  label: string
  /** Matched against the normalized, lower-cased path. */
  match: RegExp
  /** Who must approve a change to this resource. */
  approver: Approver
}

/**
 * Ordered: the first match wins, so the narrow entries that overlap a broader one come first.
 * Every pattern is written against the lower-cased normalized path.
 */
export const RESOURCE_CLASSES: ResourceClass[] = [
  {
    id: 'secrets',
    label: 'credentials and secrets',
    match: /(^|\/)\.env(\.[^/]*)?$|\.(pem|key|p12|pfx|keystore)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|\/)\.npmrc$|(^|\/)\.vercel\//,
    approver: 'owner',
  },
  {
    id: 'schema',
    label: 'database schema and migrations',
    match: /^src\/db\/(schema\.sql|migrations\/)/,
    approver: 'owner',
  },
  {
    id: 'payments',
    label: 'payments, settlement and billing',
    match:
      /^src\/payments\/|^src\/routes\/(credits|admin)\.ts$|^src\/lib\/(billing|settle|reconcile|profit|keycredit|keybudget|creditpolicy)\.ts$/,
    approver: 'owner',
  },
  {
    id: 'auth',
    label: 'authentication, session and identity',
    match: /^src\/routes\/(auth|keys)\.ts$|^src\/lib\/(session|security|keys|env)\.ts$/,
    approver: 'owner',
  },
  {
    id: 'authority',
    label: 'authority policy and agent skill packs',
    match:
      /^team\/policies\/|^team\/agents\/|^team\/organization\.json$|^team\/operating-spec\/|^src\/lib\/protectedresources\.ts$|^src\/authority\//,
    approver: 'owner',
  },
  {
    id: 'ci',
    label: 'CI workflows and repository automation',
    match: /^\.github\/|(^|\/)codeowners$/,
    approver: 'owner',
  },
  {
    id: 'deploy',
    label: 'deployment and runtime configuration',
    match: /^vercel\.json$|^api\/|^package\.json$|^package-lock\.json$|^tsconfig\.json$/,
    approver: 'owner',
  },
  {
    id: 'wallet',
    label: 'wallet, treasury and contract operations',
    match: /^contracts\/|^src\/lib\/privy|^src\/payments\/(swap|x402)\.ts$/,
    approver: 'owner',
  },
]

export type Classification = {
  resourceId: string
  label: string
  requires: Approver
}

export type WriteDecision = {
  allowed: boolean
  /** Null when the path falls outside every protected class. */
  resourceId: string | null
  requires: Approver | null
  /** Present only when the write is refused. */
  reason: string | null
  /** The normalized path the decision was made on, so a refusal can be read back. */
  normalized: string
}

const MAX_PATH = 300

/**
 * Fold every cheap disguise of the same target into one form. Anything that cannot be normalized
 * into a plain relative path is refused by the caller, not guessed at here.
 */
export function normalizePath(raw: unknown): string {
  let p = String(raw ?? '')
  try {
    p = decodeURIComponent(p)
  } catch {
    // A malformed escape is left as-is; it will fail the traversal and prefix checks.
  }
  p = p
    .normalize('NFC')
    // Homoglyph separators and dots fold to ASCII. This can only cause a false refusal, never a
    // false allow, which is the correct direction for a security boundary: a path spelled with
    // U+2215 is not a file we want an agent creating either.
    .replace(/[\u2215\u2044\uff0f\uff3c]/g, '/')
    .replace(/[\uff0e\u2024\u2027]/g, '.')
    // Zero-width characters are invisible in review and meaningless in a repository path.
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\\/g, '/')
    // Control characters and the null byte are never part of a repository path.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  while (p.startsWith('./')) p = p.slice(2)
  p = p.replace(/\/{2,}/g, '/')
  if (p.startsWith('/')) p = p.slice(1)
  return p.replace(/\/+$/, '')
}

/** The protected class a path belongs to, or null for an ordinary repository file. */
export function classifyResource(raw: unknown): Classification | null {
  const p = normalizePath(raw).toLowerCase()
  if (!p) return null
  for (const c of RESOURCE_CLASSES) {
    if (c.match.test(p)) return { resourceId: c.id, label: c.label, requires: c.approver }
  }
  return null
}

/**
 * Decide whether this actor may write this path. An agent may only touch ordinary files; a protected
 * class needs the owner. `operator` is treated exactly as strictly as `agent` until Phase B's scoped
 * operator credential exists and has its own policy version.
 */
export function authorizeWrite(raw: unknown, actor: { type: ActorType } = { type: 'agent' }): WriteDecision {
  const normalized = normalizePath(raw)
  if (!normalized) {
    return { allowed: false, resourceId: null, requires: null, reason: 'An empty path is not writable', normalized }
  }
  if (normalized.length > MAX_PATH) {
    return { allowed: false, resourceId: null, requires: null, reason: 'Path is too long to classify', normalized }
  }
  if (normalized.split('/').includes('..')) {
    return { allowed: false, resourceId: null, requires: null, reason: 'Path traversal is not allowed', normalized }
  }
  const cls = classifyResource(normalized)
  if (!cls) return { allowed: true, resourceId: null, requires: null, reason: null, normalized }
  if (actor.type === 'owner') {
    return { allowed: true, resourceId: cls.resourceId, requires: 'owner', reason: null, normalized }
  }
  return {
    allowed: false,
    resourceId: cls.resourceId,
    requires: cls.requires,
    reason: `${cls.label} (${cls.resourceId}) needs the owner's approval, not an agent's`,
    normalized,
  }
}
