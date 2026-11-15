/**
 * Protected-resource policy regressions (Phase B, B3).
 *
 * Three defects are pinned here.
 *
 * 1. The original writer held one hand-kept money-path list, so everything else sensitive was
 *    agent-writable as long as it sat under an allowed prefix: src/routes/credits.ts, src/lib/env.ts,
 *    src/lib/session.ts, src/routes/auth.ts, .github/workflows/** and team/policies/**.
 * 2. The first version of this policy left src/agents/** ordinary, which made the guard
 *    self-defeating: repo-write.ts is the enforcement point, so an agent permitted to edit it could
 *    delete the check and then write anything.
 * 3. The second version rewrote paths before authorizing them. `src/./routes/credits.ts` normalized
 *    to `src//routes/credits.ts`, classified as ordinary, and then GitHub's URL parsing resolved the
 *    dot segment back to the protected `src/routes/credits.ts`. The string authorized was not the
 *    string delivered.
 *
 * The invariant the canonical-path tests protect: what is authorized is byte-identical to what is
 * sent. Anything ambiguous is refused instead of repaired.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { authorizeWrite, classifyResource, checkPath, normalizePath, pathRejection, RESOURCE_CLASSES } = await import(
  '../src/lib/protectedResources.js'
)

const agent = { type: 'agent' as const }
const operator = { type: 'operator' as const }

/** Every enforcement or execution boundary named in the B3 correction. */
const CONTROL_PLANE_FILES = [
  'src/agents/repo-write.ts',
  'src/agents/runner.ts',
  'src/agents/repo-tools.ts',
  'src/agents/cron.ts',
  'src/agents/schedule-lock.ts',
  'src/agents/audit-log.ts',
  'src/agents/pipeline.ts',
  'src/agents/monitor.ts',
  'src/agents/mcp.ts',
  'src/agents/x402.ts',
  'src/agents/retry.ts',
  'src/agents/credit.ts',
  'src/routes/agents.ts',
  'src/routes/cron.ts',
  'src/routes/agents-operator.ts',
  'src/lib/protectedResources.ts',
  'src/lib/config-guard.ts',
  'src/lib/ssrf.ts',
  'src/index.ts',
  'src/app.ts',
  'src/inngest/functions.ts',
  'src/team/validate.ts',
  'src/telemetry/langfuse.ts',
]

/** The protected sample set used for the actor matrix. */
const PROTECTED_SAMPLES = [
  '.env',
  'src/providers/index.ts',
  'src/db/schema.sql',
  'src/routes/credits.ts',
  'src/routes/redeem.ts',
  'src/lib/env.ts',
  'team/policies/authority.md',
  '.github/workflows/ci.yml',
  'vercel.json',
  'contracts/Thirdeye.sol',
  ...CONTROL_PLANE_FILES,
]

/**
 * Resolve a path the way the GitHub contents URL now receives it: one segment at a time, so nothing
 * in a segment can be read as a URL delimiter or a dot segment.
 */
function urlResolvedPath(p: string): string {
  const encoded = p.split('/').map(encodeURIComponent).join('/')
  const url = new URL('https://api.github.com/repos/o/r/contents/' + encoded)
  return decodeURIComponent(url.pathname.replace('/repos/o/r/contents/', ''))
}

/**
 * Resolve a path the way the previous code sent it: the whole path through encodeURI. This is the
 * divergence the fix exists for, and it is asserted so the reason for the refusal stays visible.
 */
function legacyResolvedPath(p: string): string {
  const url = new URL('https://api.github.com/repos/o/r/contents/' + encodeURI(p))
  return decodeURIComponent(url.pathname.replace('/repos/o/r/contents/', ''))
}

describe('control plane', () => {
  it('refuses every enforcement and execution file to an agent', () => {
    for (const p of CONTROL_PLANE_FILES) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must not be agent-writable`)
      assert.ok(d.resourceId, `${p} must classify into a protected class`)
      assert.match(String(d.reason), /owner/)
    }
  })

  it('refuses the writer and the permission module themselves (self-modification)', () => {
    const writer = authorizeWrite('src/agents/repo-write.ts', agent)
    const policy = authorizeWrite('src/lib/protectedResources.ts', agent)
    assert.equal(writer.allowed, false)
    assert.equal(writer.resourceId, 'control-plane')
    assert.equal(policy.allowed, false)
    assert.equal(policy.resourceId, 'authority')
  })

  it('protects files that do not exist yet, so new entry points are denied by default', () => {
    for (const p of [
      'src/routes/operator.ts',
      'src/routes/authority.ts',
      'src/routes/monitor.ts',
      'src/agents/permissions.ts',
      'src/agents/authority-engine.ts',
      'src/lib/operatorAuth.ts',
      'src/lib/review.ts',
      'src/inngest/authority.ts',
    ]) {
      assert.equal(authorizeWrite(p, agent).allowed, false, `${p} must be denied by default`)
    }
  })

  it('refuses the relay policy and the Paragraph key client', () => {
    // src/antseed/analyst.ts narrows model, system prompt, tools and token limits; stripping those
    // turns the relay into a raw proxy. src/lib/paragraph.ts reads PARAGRAPH_API_KEY.
    const relay = authorizeWrite('src/antseed/analyst.ts', agent)
    assert.equal(relay.allowed, false)
    assert.equal(relay.resourceId, 'control-plane')
    const paragraph = authorizeWrite('src/lib/paragraph.ts', agent)
    assert.equal(paragraph.allowed, false)
    assert.equal(paragraph.resourceId, 'secrets')
    // Both are the same files the review named, and both stay owner-writable rather than blocked.
    assert.equal(authorizeWrite('src/antseed/analyst.ts', { type: 'owner' }).allowed, true)
    assert.equal(authorizeWrite('src/lib/paragraph.ts', { type: 'owner' }).allowed, true)
  })

  it('refuses the money, auth, secrets, schema, policy and CI classes too', () => {
    const samples: Record<string, string> = {
      secrets: '.env',
      schema: 'src/db/schema.sql',
      payments: 'src/routes/credits.ts',
      auth: 'src/lib/env.ts',
      authority: 'team/policies/authority.md',
      ci: '.github/workflows/ci.yml',
      deploy: 'vercel.json',
      wallet: 'contracts/Thirdeye.sol',
    }
    for (const c of RESOURCE_CLASSES) {
      const path = samples[c.id]
      if (!path) continue
      const d = authorizeWrite(path, agent)
      assert.equal(d.allowed, false, `${path} must not be agent-writable`)
      assert.equal(d.resourceId, c.id, `${path} must classify as ${c.id}`)
    }
  })
})

describe('payments classification', () => {
  it('classifies the redeem and settlement routes as payments, not the control-plane catch-all', () => {
    for (const p of ['src/routes/redeem.ts', 'src/routes/credits.ts', 'src/routes/profit.ts', 'src/routes/admin.ts']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.resourceId, 'payments', `${p} must carry the payments boundary`)
      assert.equal(d.requires, 'owner')
      assert.equal(d.allowed, false)
    }
  })

  it('keeps the payments class ahead of the control-plane matcher in the policy order', () => {
    const ids = RESOURCE_CLASSES.map((c) => c.id)
    // Two control-plane entries exist (the route/agent catch-all, then the named lib modules), so the
    // meaningful comparison is against the first one: payments must be reached before the catch-all.
    assert.equal(ids.filter((id) => id === 'control-plane').length, 2)
    assert.ok(ids.indexOf('payments') < ids.indexOf('control-plane'), 'payments must precede the first catch-all')
  })
})

describe('operator actor', () => {
  it('is refused for every protected class exactly as an agent is', () => {
    for (const p of PROTECTED_SAMPLES) {
      const d = authorizeWrite(p, operator)
      assert.equal(d.allowed, false, `${p} must not be operator-writable`)
      assert.ok(d.resourceId, `${p} must classify`)
      assert.match(String(d.reason), /owner/)
    }
  })

  it('stays allowed only on ordinary application paths', () => {
    for (const p of ['web/src/a.tsx', 'docs/a.md', 'tests/x.test.ts']) {
      assert.equal(authorizeWrite(p, operator).allowed, true, `${p} stays writable`)
    }
  })
})

describe('ordinary application paths', () => {
  it('stay writable, so the guard does not stop all work', () => {
    for (const p of ['web/src/pages1.tsx', 'tests/x.test.ts', 'docs/a.md', 'src/lib/format.ts', 'web/src/components/Hero.tsx']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, true, `${p} must stay writable`)
      assert.equal(d.resourceId, null)
    }
  })

  it('allow exactly the three named content routes and nothing else under routes/', () => {
    for (const p of ['src/routes/public.ts', 'src/routes/whitepaper.ts', 'src/routes/discovery.ts']) {
      assert.equal(authorizeWrite(p, agent).allowed, true, `${p} is content and stays writable`)
    }
    for (const p of ['src/routes/stats.ts', 'src/routes/feedback.ts', 'src/routes/playground.ts', 'src/routes/v1.ts']) {
      assert.equal(authorizeWrite(p, agent).allowed, false, `${p} is a route and is control plane`)
    }
  })

  it('applies the content exemption to the exact case only', () => {
    // GitHub paths are case-sensitive, so a differently-cased spelling is a different file and must
    // not inherit the exemption by being lowercased before the comparison.
    assert.equal(authorizeWrite('src/routes/public.ts', agent).allowed, true)
    for (const p of ['src/routes/Public.ts', 'src/routes/WHITEPAPER.ts', 'src/routes/Discovery.ts']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must not inherit the content exemption`)
      assert.equal(d.resourceId, 'control-plane', `${p} must classify as control plane`)
    }
  })

  it('classifies uppercase and mixed-case protected paths as protected', () => {
    // The exact-case content exemption must not weaken protected matching, which is case-insensitive.
    const expected: Record<string, string> = {
      'SRC/AGENTS/REPO-WRITE.TS': 'control-plane',
      'Src/Routes/Agents.ts': 'control-plane',
      'SRC/PROVIDERS/INDEX.TS': 'secrets',
      'SRC/PAYMENTS/SWAP.TS': 'payments',
      'Team/Policies/Authority.md': 'authority',
      '.GITHUB/workflows/ci.yml': 'ci',
    }
    for (const [p, id] of Object.entries(expected)) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
      assert.equal(d.resourceId, id, `${p} must classify as ${id}`)
    }
  })

  it('the owner may write a protected path, and the decision names the class', () => {
    const d = authorizeWrite('src/agents/repo-write.ts', { type: 'owner' })
    assert.equal(d.allowed, true)
    assert.equal(d.resourceId, 'control-plane')
    assert.equal(d.requires, 'owner')
  })
})

describe('path canonicalization', () => {
  it('refuses internal dot segments instead of resolving them', () => {
    // The reported bypass: authorized as ordinary, resolved by URL parsing to the protected file.
    for (const p of [
      'src/./routes/credits.ts',
      'src/./agents/repo-write.ts',
      'src/routes/./credits.ts',
      'src/agents/./audit-log.ts',
    ]) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
      assert.match(String(d.reason), /dot segment/)
      // Proof the refusal is necessary: sent the old way, the URL resolves to a different file.
      assert.notEqual(legacyResolvedPath(p), p, `${p} resolves elsewhere under URL parsing`)
    }
  })

  it('refuses parent traversal anywhere in the path', () => {
    for (const p of [
      'src/agents/../../src/payments/swap.ts',
      'src/agents/../payments/swap.ts',
      'src/routes/../agents/audit-log.ts',
      '../etc/passwd',
    ]) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
      assert.match(String(d.reason), /traversal/)
    }
  })

  it('refuses query and fragment delimiters that URL parsing would silently drop', () => {
    for (const p of ['src/routes/credits.ts?ref=main', 'src/routes/credits.ts#frag', 'web/src/a.tsx?x=1']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
      assert.match(String(d.reason), /query or fragment/)
      assert.notEqual(legacyResolvedPath(p), p, `${p} would be truncated by URL parsing`)
    }
  })

  it('refuses repeated, trailing and leading slashes rather than collapsing them', () => {
    for (const p of ['src//routes/credits.ts', 'src/agents//repo-write.ts', 'src/agents/x.ts/', '/src/agents/x.ts']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
    }
  })

  it('refuses encoding in every form: malformed, double and single', () => {
    assert.equal(pathRejection('src/payments/x%2.ts'), 'A malformed percent escape is ambiguous')
    assert.equal(pathRejection('%zzsrc/agents/runner.ts'), 'A malformed percent escape is ambiguous')
    assert.equal(pathRejection('%252e%252e%252fsrc%252fagents%252frunner.ts'), 'Double-encoded paths are ambiguous')
    assert.equal(pathRejection('src%2fagents%2frepo-write.ts'), 'Percent-encoded paths are ambiguous')
    assert.equal(pathRejection('..%2fsrc%2fagents%2frepo-write.ts'), 'Percent-encoded paths are ambiguous')
  })

  it('refuses separators, invisible characters and control characters that disguise the target', () => {
    for (const p of [
      '.\\src\\agents\\repo-write.ts',
      'src\\agents\\audit-log.ts',
      'src\u2215agents\u2215pipeline.ts',
      'src/agents/repo\u200b-write.ts',
      'src/agents/run\u0000ner.ts',
      '  src/agents/cron.ts',
      'src/agents/cron.ts ',
    ]) {
      assert.equal(authorizeWrite(p, agent).allowed, false, `${JSON.stringify(p)} must be refused`)
    }
  })

  it('refuses absolute paths, drive letters, empty and over-long paths', () => {
    assert.equal(pathRejection('/src/agents/runner.ts'), 'Absolute paths are not writable')
    assert.equal(pathRejection('C:/src/agents/runner.ts'), 'Absolute paths are not writable')
    assert.equal(pathRejection(''), 'An empty path is not writable')
    assert.equal(pathRejection('./'), 'An empty path is not writable')
    assert.equal(authorizeWrite('src/' + 'a/'.repeat(200) + 'x.ts', agent).allowed, false)
  })

  it('accepts a single leading ./ and returns the stripped path as the one to send', () => {
    assert.deepEqual(checkPath('./web/src/a.tsx'), { ok: true, path: 'web/src/a.tsx' })
    const d = authorizeWrite('./web/src/a.tsx', agent)
    assert.equal(d.allowed, true)
    assert.equal(d.normalized, 'web/src/a.tsx')
    assert.equal(authorizeWrite('./src/routes/public.ts', agent).allowed, true)
    assert.equal(authorizeWrite('./src/routes/credits.ts', agent).allowed, false)
  })

  it('never reports a path it did not validate: normalizePath returns empty instead of rewriting', () => {
    assert.equal(normalizePath('src/./routes/credits.ts'), '')
    assert.equal(normalizePath('src//routes/credits.ts'), '')
    assert.equal(normalizePath('web/src/a.tsx'), 'web/src/a.tsx')
  })

  it('proves no protected destination is reachable through URL normalization', () => {
    const attempts = [
      'src/./routes/credits.ts',
      'src/./agents/repo-write.ts',
      'src/routes/./agents.ts',
      'src/routes/credits.ts?x=1',
      'src/routes/credits.ts#x',
      'src//routes/credits.ts',
      'src/agents/../routes/credits.ts',
      'src%2froutes%2fcredits.ts',
      '.hidden/../src/routes/credits.ts',
    ]
    for (const p of attempts) {
      const d = authorizeWrite(p, agent)
      // Either the policy refuses it, or the string it authorizes resolves to itself. Both are safe;
      // an authorization whose URL target differs from the authorized path is the bug, and it cannot
      // occur here.
      if (d.allowed) assert.equal(urlResolvedPath(d.normalized), d.normalized, `${p} authorized a path that moves`)
      else assert.equal(d.allowed, false)
    }
    // And every ordinary path that is allowed round-trips through URL parsing unchanged.
    for (const p of ['web/src/a.tsx', 'docs/a.md', 'src/lib/format.ts', 'src/routes/public.ts']) {
      assert.equal(urlResolvedPath(p), p, `${p} must round-trip`)
    }
  })
})

describe('batch writes', () => {
  it('refuse the whole batch and name the protected file, so there is no partial write', async () => {
    const { validateWriteBatch } = await import('../src/agents/repo-write.js')
    const files = [
      { path: 'web/src/a.tsx', content: 'export const a = 1' },
      { path: 'src/agents/repo-write.ts', content: 'export const b = 2' },
      { path: 'docs/c.md', content: '# c' },
    ]
    assert.throws(() => validateWriteBatch(files as any), /repo-write\.ts/)
  })

  it('refuses an ordinary batch that would slip a control-plane file in at the cap', async () => {
    const { validateWriteBatch } = await import('../src/agents/repo-write.js')
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `docs/page-${i}.md`, content: '# page' }))
    files.push({ path: 'src/agents/runner.ts', content: 'export const x = 1' })
    let message = ''
    try {
      validateWriteBatch(files as any)
    } catch (e: any) {
      message = String(e?.message || '')
    }
    // Pin both facts: the named file caused it, and the reason is the owner-only class rather than
    // an unrelated prefix or size refusal.
    assert.match(message, /src\/agents\/runner\.ts/)
    assert.match(message, /owner's approval/)
  })

  it('refuses a batch whose member is a dot-segment disguise of a protected file', async () => {
    const { validateWriteBatch } = await import('../src/agents/repo-write.js')
    const files = [
      { path: 'docs/page.md', content: '# page' },
      { path: 'src/./routes/credits.ts', content: 'export const y = 2' },
    ]
    assert.throws(() => validateWriteBatch(files as any), /dot segment/)
  })
})

describe('classification stability', () => {
  it('classifies on the validated path', () => {
    assert.deepEqual(checkPath('src/agents/x.ts'), { ok: true, path: 'src/agents/x.ts' })
    assert.equal(classifyResource('src/agents/x.ts')?.resourceId, 'control-plane')
    assert.equal(classifyResource('src/lib/format.ts'), null)
    assert.equal(classifyResource('src/routes/public.ts'), null)
    assert.equal(classifyResource('src/./routes/credits.ts'), null, 'an invalid path is not classified at all')
  })
})
