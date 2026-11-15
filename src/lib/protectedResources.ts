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

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Validate a path and return the exact string that may be written, or the reason it cannot be.
 *
 * The invariant this function exists to hold: the string that is authorized is the string that is
 * sent to GitHub, byte for byte. Anything whose meaning could change between here and the GitHub
 * contents API is refused instead of repaired. That matters because the API receives the path inside
 * a URL, and URL parsing resolves `./` and `..` segments and stops at `?` and `#`. A path like
 * `src/./routes/credits.ts` would be authorized as one string and then land on a different file.
 *
 * The only thing removed is a single leading `./`, which cannot mean anything else; the stripped
 * form is what gets authorized and returned, so the invariant still holds. Every other rewrite is a
 * refusal.
 */
export function checkPath(raw: unknown): PathCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'A path must be a string' }
  if (!raw.trim()) return { ok: false, reason: 'An empty path is not writable' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'A path may not contain control characters' }
  if (/\s/.test(raw)) return { ok: false, reason: 'A path may not contain whitespace' }
  if (raw.length > MAX_PATH + 2) return { ok: false, reason: 'Path is too long' }

  if (raw.includes('%')) {
    if (/%(?![0-9a-fA-F]{2})/.test(raw)) return { ok: false, reason: 'A malformed percent escape is ambiguous' }
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return { ok: false, reason: 'An undecodable percent escape is ambiguous' }
    }
    // A percent sequence surviving one decode means the input was encoded more than once, and a
    // single encoding still means two possible readings. Both are refused rather than resolved.
    if (/%[0-9a-fA-F]{2}/.test(decoded)) return { ok: false, reason: 'Double-encoded paths are ambiguous' }
    return { ok: false, reason: 'Percent-encoded paths are ambiguous' }
  }

  if (/[?#]/.test(raw)) return { ok: false, reason: 'A query or fragment delimiter is ambiguous' }
  if (raw.includes('\\')) return { ok: false, reason: 'Backslash separators are ambiguous' }
  if (/[\u2215\u2044\uff0f\uff3c\uff0e\u2024\u2027\u200b-\u200d\u2060\ufeff]/.test(raw)) {
    return { ok: false, reason: 'A non-ASCII separator or invisible character is ambiguous' }
  }
  if (raw.normalize('NFC') !== raw) return { ok: false, reason: 'A decomposed character sequence is ambiguous' }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { ok: false, reason: 'Absolute paths are not writable' }

  const stripped = raw.startsWith('./') ? raw.slice(2) : raw
  if (!stripped) return { ok: false, reason: 'An empty path is not writable' }
  if (stripped.length > MAX_PATH) return { ok: false, reason: 'Path is too long' }

  const segments = stripped.split('/')
  if (segments.some((seg) => seg === '')) {
    return { ok: false, reason: 'A repeated or trailing slash is ambiguous' }
  }
  if (segments.some((seg) => seg === '..')) return { ok: false, reason: 'Path traversal is not allowed' }
  if (segments.some((seg) => seg === '.')) {
    return { ok: false, reason: 'A dot segment (.) is not allowed: it would resolve to a different file' }
  }
  return { ok: true, path: stripped }
}

/** The refusal reason for a path, or null when it is writable in principle. */
export function pathRejection(raw: unknown): string | null {
  const check = checkPath(raw)
  return check.ok ? null : check.reason
}

/**
 * Kept for callers that want a plain string. It no longer invents a path: an input that is not
 * already canonical returns '', because a silent rewrite is exactly the bug this replaced.
 */
export function normalizePath(raw: unknown): string {
  const check = checkPath(raw)
  return check.ok ? check.path : ''
}

/** The protected class a path belongs to, or null for an ordinary application file. */
export function classifyResource(raw: unknown): Classification | null {
  const check = checkPath(raw)
  if (!check.ok) return null
  const p = check.path.toLowerCase()
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
  const check = checkPath(raw)
  if (!check.ok) {
    return { allowed: false, resourceId: null, requires: null, reason: check.reason, normalized: String(raw ?? '') }
  }
  const normalized = check.path
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
