/**
 * Protected-resource policy regressions (Phase B, workstream B3).
 *
 * The defect these cases pin: the repository writer held one hand-kept money-path list, so every
 * other sensitive surface was agent-writable as long as it sat under an allowed prefix. `src/routes/
 * credits.ts`, `src/lib/env.ts`, `src/lib/session.ts`, `src/routes/auth.ts`, `.github/workflows/**`
 * and `team/policies/**` were all writable. The policy now lives in one module and is consulted at
 * the write boundary, not in a tool description.
 *
 * Each bypass case below is a one-character disguise of a path that must be refused. They are here
 * because a path check that only reads the raw string is a path check that can be spelled around.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { authorizeWrite, classifyResource, normalizePath, RESOURCE_CLASSES } = await import(
  '../src/lib/protectedResources.js'
)

const agent = { type: 'agent' as const }

describe('protected resources', () => {
  it('refuses every declared class to an agent, and names the class', () => {
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
      assert.ok(path, `no sample path for class ${c.id}`)
      const d = authorizeWrite(path, agent)
      assert.equal(d.allowed, false, `${path} must not be agent-writable`)
      assert.equal(d.resourceId, c.id, `${path} must classify as ${c.id}`)
      assert.match(String(d.reason), /owner/)
    }
  })

  it('keeps the ordinary path allowed, so the guard does not stop all work', () => {
    for (const p of ['src/agents/runner.ts', 'web/src/pages1.tsx', 'tests/x.test.ts', 'docs/a.md', 'src/lib/format.ts']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, true, `${p} must stay writable`)
      assert.equal(d.resourceId, null)
    }
  })

  it('the owner may write a protected path, and the decision says which class', () => {
    const d = authorizeWrite('src/routes/credits.ts', { type: 'owner' })
    assert.equal(d.allowed, true)
    assert.equal(d.resourceId, 'payments')
    assert.equal(d.requires, 'owner')
  })

  it('collapses traversal rather than trusting the raw string', () => {
    for (const p of [
      'src/agents/../../src/payments/swap.ts',
      'src/agents/../payments/swap.ts',
      '..%2fsrc%2fpayments%2fswap.ts',
      './src/../src/db/schema.sql',
    ]) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
    }
  })

  it('does not let case or encoding change the class', () => {
    for (const p of ['SRC/Payments/swap.ts', 'src/PAYMENTS/swap.ts', 'src/payments/swap.ts%00', '.ENV', 'src\u2215lib\u2215billing.ts']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
    }
  })

  it('normalizes separators, duplicate slashes, dot prefixes and padding', () => {
    for (const p of ['.\\src\\payments\\swap.ts', 'src//payments///swap.ts', '  ./src/payments/swap.ts  ', 'src\\payments\\swap.ts']) {
      const d = authorizeWrite(p, agent)
      assert.equal(d.allowed, false, `${p} must be refused`)
      assert.equal(d.resourceId, 'payments', `${p} must still classify as payments`)
    }
  })

  it('strips control characters instead of letting them break the match', () => {
    for (const p of ['src/payments/sw\u0000ap.ts', 'src/p\u0007ayments/swap.ts']) {
      assert.equal(authorizeWrite(p, agent).resourceId, 'payments', `${JSON.stringify(p)} must still classify`)
    }
  })

  it('refuses an empty or over-long path instead of guessing', () => {
    assert.equal(authorizeWrite('', agent).allowed, false)
    assert.equal(authorizeWrite('./', agent).allowed, false)
    assert.equal(authorizeWrite('src/' + 'a/'.repeat(200) + 'x.ts', agent).allowed, false)
  })

  it('a batch is refused as a whole when one member is protected, naming the file', async () => {
    const { validateWriteBatch } = await import('../src/agents/repo-write.js')
    const files = [
      { path: 'src/agents/x.ts', content: 'export const x = 1' },
      { path: 'src/routes/credits.ts', content: 'export const y = 2' },
      { path: 'docs/z.md', content: '# z' },
    ]
    assert.throws(() => validateWriteBatch(files as any), /credits\.ts/)
  })

  it('classification is stable on the normalized form', () => {
    assert.equal(normalizePath('./src//payments/x.ts'), 'src/payments/x.ts')
    assert.equal(classifyResource('src/payments/x.ts')?.resourceId, 'payments')
    assert.equal(classifyResource('src/lib/format.ts'), null)
  })
})
