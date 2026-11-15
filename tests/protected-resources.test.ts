/**
 * Protected-resource policy regressions (Phase B, B3).
 *
 * Two defects are pinned here.
 *
 * 1. The original writer held one hand-kept money-path list, so everything else sensitive was
 *    agent-writable as long as it sat under an allowed prefix: src/routes/credits.ts, src/lib/env.ts,
 *    src/lib/session.ts, src/routes/auth.ts, .github/workflows/** and team/policies/**.
 * 2. The first version of this policy left src/agents/** ordinary, which made the guard
 *    self-defeating. repo-write.ts is the enforcement point, so an agent permitted to edit it could
 *    delete the check and then write anything. The control-plane class and the self-modification
 *    cases below exist for that reason.
 *
 * Every disguise case is a one-character or one-escape variant of a path that must be refused,
 * because a path check that only reads the raw string is a path check that can be spelled around.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { authorizeWrite, classifyResource, normalizePath, pathRejection, RESOURCE_CLASSES } = await import(
  '../src/lib/protectedResources.js'
)

const agent = { type: 'agent' as const }

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
  'src/inngest/functions.ts',
]

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

describe('ordinary application paths', () => {
  it('stay writable, so the guard does not stop all work', () => {
    for (const p of [
      'web/src/pages1.tsx',
      'tests/x.test.ts',
      'docs/a.md',
      'src/lib/format.ts',
      'web/src/components/Hero.tsx',
    ]) {
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

  it('the owner may write a protected path, and the decision names the class', () => {
    const d = authorizeWrite('src/agents/repo-write.ts', { type: 'owner' })
    assert.equal(d.allowed, true)
    assert.equal(d.resourceId, 'control-plane')
    assert.equal(d.requires, 'owner')
  })
})

describe('path disguises', () => {
  it('collapses traversal, including into the control plane', () => {
    for (const p of [
      'src/agents/../../src/payments/swap.ts',
      'src/agents/../payments/swap.ts',
      'src/lib/../agents/repo-write.ts',
      'src/routes/../agents/audit-log.ts',
      './src/../src/agents/runner.ts',
    ]) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
    }
  })

  it('refuses single, double and malformed percent encoding instead of decoding twice', () => {
    assert.equal(authorizeWrite('..%2fsrc%2fagents%2frepo-write.ts', agent).allowed, false)
    assert.equal(authorizeWrite('%252e%252e%252fsrc%252fagents%252frunner.ts', agent).allowed, false)
    assert.equal(pathRejection('%252e%252e%252f'), 'Double-encoded paths are ambiguous')
    assert.equal(pathRejection('src/payments/x%2.ts'), 'A malformed percent escape is ambiguous')
    assert.equal(pathRejection('src/payments/100%.ts'), 'A malformed percent escape is ambiguous')
    assert.equal(pathRejection('%zzsrc/agents/runner.ts'), 'A malformed percent escape is ambiguous')
  })

  it('refuses control characters rather than stripping them into a different path', () => {
    assert.equal(pathRejection('src/agents/run\u0000ner.ts'), 'A path may not contain control characters')
    assert.equal(authorizeWrite('src/agents/run\u0007ner.ts', agent).allowed, false)
    assert.equal(authorizeWrite('src/agents/run\u0000ner.ts', agent).allowed, false)
  })

  it('does not let case change the class', () => {
    for (const p of ['SRC/Agents/REPO-WRITE.ts', 'Src/Routes/Agents.ts', 'SRC/PAYMENTS/swap.ts', '.ENV']) {
      assert.equal(authorizeWrite(p, agent).allowed, false, `${p} must be refused`)
    }
  })

  it('normalizes separators, duplicate slashes, dot prefixes and padding', () => {
    for (const p of [
      '.\\src\\agents\\repo-write.ts',
      'src//agents///runner.ts',
      '  ./src/agents/cron.ts  ',
      'src\\agents\\audit-log.ts',
      'src/\u2215agents\u2215pipeline.ts',
    ]) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
      assert.equal(d.resourceId, 'control-plane', `${p} must classify as control-plane`)
    }
  })

  it('refuses absolute, empty and over-long paths instead of guessing', () => {
    assert.equal(authorizeWrite('', agent).allowed, false)
    assert.equal(authorizeWrite('./', agent).allowed, false)
    assert.equal(pathRejection('/src/agents/runner.ts'), 'Absolute paths are not writable')
    assert.equal(pathRejection('C:\\src\\agents\\runner.ts'), 'Absolute paths are not writable')
    assert.equal(authorizeWrite('src/' + 'a/'.repeat(200) + 'x.ts', agent).allowed, false)
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
    assert.throws(() => validateWriteBatch(files as any), /control-plane|owner/)
  })
})

describe('classification stability', () => {
  it('classifies on the normalized form', () => {
    assert.equal(normalizePath('./src//agents/x.ts'), 'src/agents/x.ts')
    assert.equal(classifyResource('src/agents/x.ts')?.resourceId, 'control-plane')
    assert.equal(classifyResource('src/lib/format.ts'), null)
    assert.equal(classifyResource('src/routes/public.ts'), null)
  })
})
