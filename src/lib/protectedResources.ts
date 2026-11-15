/**
 * Protected-resource classification for every write an agent may propose.
 *
 * The rule this module holds: what a path *is* decides who may change it, and the decision is made
 * at the write boundary in `src/agents/repo-write.ts` rather than in a tool description.
 *
 * Why the control plane is first-class here. An earlier version of this module left `src/agents/**`
 * ordinary, which made the guard self-defeating: `repo-write.ts` is the enforcement point, so an
 * agent allowed to edit it could remove the check and then write anything. The same argument covers
 * the runtime, the scheduler, the audit log, the pipeline and every privileged route: if a file can
 * change who may act, it is authority, and authority is not agent-writable.
 *
 * Three deliberate choices:
 *
 *  1. Privileged directories are denied as a whole (`src/agents/**`, `src/routes/**`,
 *     `src/inngest/**`, `src/db/**`, `team/**`, `.github/**`, `contracts/**`). A new file in one of
 *     them is protected the moment it exists, so nobody has to remember to add it to a list. Only a
 *     short, named content allowlist is exempt, and a test pins that exemption.
 *  2. Classification runs on a validated, normalized path, never the raw string. Ambiguous or
 *     double-percent-encoded input is refused outright instead of being guessed at.
 *  3. Unknown is not automatically allowed: anything in a protected class is refused for an agent
 *     actor and names the class, so the refusal is actionable.
 */

export type ActorType = 'agent' | 'operator' | 'owner'
export type Approver = 'owner' | 'agent'

export type ResourceClass = {
  /** Stable id used in refusals, audit rows and tests. */
  id: string
  label: string
  /** Matched against the normalized, lower-cased path. */
  match: RegExp
  approver: Approver
}

/**
 * Public content pages an agent may still edit. These render text and read-only metadata; none of
 * them authenticates, spends, schedules, delegates or reaches GitHub. Every other route is control
 * plane, including any route file added later.
 */
export const CONTENT_ROUTE_ALLOWLIST = ['src/routes/public.ts', 'src/routes/whitepaper.ts', 'src/routes/discovery.ts']

/** Execution, authorization and bookkeeping modules. Named explicitly so the refusal says which. */
const CONTROL_PLANE_LIB =
  /^src\/lib\/(protectedresources|operatorauth|attribution|review|repopolicy|config-guard|ssrf|ratelimit|security|session|env|keys|allowance|sweepguard|partnerverify|pricing|streamaccounting|tokenusage|usage)\.ts$/

/**
 * Ordered: the first match wins, so a specific class beats the control-plane catch-all and its
 * refusal message names the reason a reader would expect.
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
    match: /^src\/db\//,
    approver: 'owner',
  },
  {
    id: 'payments',
    label: 'payments, settlement and billing',
    match:
      /^src\/payments\/|^src\/routes\/(credits|admin|profit|redeem)\.ts$|^src\/lib\/(billing|settle|reconcile|profit|keycredit|keybudget|creditpolicy)\.ts$/,
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
    match: /^team\/|^src\/lib\/protectedresources\.ts$|^src\/authority\//,
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
    match: /^vercel\.json$|^package\.json$|^package-lock\.json$|^tsconfig\.json$/,
    approver: 'owner',
  },
  {
    id: 'wallet',
    label: 'wallet, treasury and contract operations',
    match: /^contracts\/|^src\/lib\/privy|^src\/payments\/(swap|x402)\.ts$/,
    approver: 'owner',
  },
  {
    id: 'control-plane',
    label: 'agent execution, authorization or audit control plane',
    // src/agents/** includes repo-write.ts, the enforcement point itself: an agent that may edit it
    // can remove the check. src/index.ts registers the middleware that authenticates every route.
    match: /^src\/agents\/|^src\/routes\/|^src\/inngest\/|^src\/index\.ts$|^api\/|^src\/middleware/,
    approver: 'owner',
  },
  {
    id: 'control-plane',
    label: 'agent execution, authorization or audit control plane',
    match: CONTROL_PLANE_LIB,
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
  resourceId: string | null
  requires: Approver | null
  reason: string | null
  /** The normalized path the decision was made on, so a refusal can be read back. */
  normalized: string
}

const MAX_PATH = 300

/** True for the named public content pages, which are ordinary application paths. */
export function isContentRoute(raw: unknown): boolean {
  const p = normalizePath(raw).toLowerCase()
  return CONTENT_ROUTE_ALLOWLIST.includes(p)
}

/**
 * Refuse anything whose meaning depends on how it is decoded.
 *
 * The writer commits through GitHub's contents API, where the path arrives percent-encoded once. A
 * second layer of encoding (`%252e%252e%252f`), a malformed escape (`%zz`), or a bare `%` left after
 * decoding all mean the path has two possible readings, and the request that reaches GitHub may not
 * be the path that was classified here. There is no safe guess, so these are refused rather than
 * normalized.
 */
export function pathRejection(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'A path must be a string'
  const original = raw
  if (!original.trim()) return 'An empty path is not writable'
  if (original.length > MAX_PATH * 3) return 'Path is too long'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(original)) return 'A path may not contain control characters'

  let decoded = original
  if (original.includes('%')) {
    if (/%(?![0-9a-fA-F]{2})/.test(original)) return 'A malformed percent escape is ambiguous'
    try {
      decoded = decodeURIComponent(original)
    } catch {
      return 'An undecodable percent escape is ambiguous'
    }
    // A percent sequence surviving one decode means the input was encoded more than once.
    if (/%[0-9a-fA-F]{2}/.test(decoded)) return 'Double-encoded paths are ambiguous'
    if (decoded.includes('%')) return 'A bare percent sign in a path is ambiguous'
  }

  const p = decoded.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return 'Absolute paths are not writable'
  const segments = p.split('/')
  if (segments.some((s) => s === '..')) return 'Path traversal is not allowed'
  if (p.length > MAX_PATH) return 'Path is too long'
  return null
}

/**
 * Fold every cheap disguise of the same target into one form. Only called on input that
 * `pathRejection` accepted, so the folding here decides classification, never legality.
 */
export function normalizePath(raw: unknown): string {
  let p = String(raw ?? '').trim()
  p = p
    .normalize('NFC')
    // Homoglyph separators and dots fold to ASCII. This can only cause a false refusal, never a
    // false allow, which is the correct direction for a security boundary.
    .replace(/[\u2215\u2044\uff0f\uff3c]/g, '/')
    .replace(/[\uff0e\u2024\u2027]/g, '.')
    // Zero-width characters are invisible in review and meaningless in a repository path.
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  p = p.replace(/\/{2,}/g, '/')
  if (p.startsWith('/')) p = p.slice(1)
  p = p.replace(/\/+$/, '')
  return p.replace(/(^|\/)\.(?=\/|$)/g, '$1')
}

/** The protected class a path belongs to, or null for an ordinary application file. */
export function classifyResource(raw: unknown): Classification | null {
  const normalized = normalizePath(raw)
  const p = normalized.toLowerCase()
  if (!p) return null
  if (CONTENT_ROUTE_ALLOWLIST.includes(p)) return null
  for (const c of RESOURCE_CLASSES) {
    if (c.match.test(p)) return { resourceId: c.id, label: c.label, requires: c.approver }
  }
  return null
}

/**
 * Decide whether this actor may write this path. An agent may only touch ordinary application files;
 * every protected class needs the owner. `operator` is treated exactly as strictly as `agent` until
 * Phase B's scoped operator credential exists with its own policy version.
 */
export function authorizeWrite(raw: unknown, actor: { type: ActorType } = { type: 'agent' }): WriteDecision {
  const rejection = pathRejection(raw)
  const normalized = rejection ? String(raw ?? '') : normalizePath(raw)
  if (!rejection && !normalized) {
    return { allowed: false, resourceId: null, requires: null, reason: 'An empty path is not writable', normalized }
  }
  if (rejection) {
    return { allowed: false, resourceId: null, requires: null, reason: rejection, normalized }
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
