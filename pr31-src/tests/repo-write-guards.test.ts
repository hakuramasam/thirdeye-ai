import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  validateWritePath,
  validateBranchName,
  validateWriteBatch,
  detectSecret,
  WRITE_MAX_FILES,
} = await import('../src/agents/repo-write.js')

test('writable paths inside the allowlist pass', () => {
  for (const p of ['src/agents/x.ts', 'web/src/a.tsx', 'tests/t.test.ts', 'docs/a.md', 'team/policies/a.md', '.github/workflows/ci.yml']) {
    assert.equal(validateWritePath(p), p)
  }
})

test('refuses money, keys, schema and secrets by path', () => {
  for (const p of ['src/payments/verify.ts', 'src/lib/billing.ts', 'src/lib/keys.ts', 'src/db/schema.sql', '.env', 'secrets.json', 'src/x.pem']) {
    assert.throws(() => validateWritePath(p), /Refusing|Invalid/)
  }
})

test('refuses traversal, absolute escapes and unlisted directories', () => {
  assert.throws(() => validateWritePath('../etc/passwd'), /traversal/)
  assert.throws(() => validateWritePath('/etc/passwd'), /Refusing/)
  assert.throws(() => validateWritePath('scripts/deploy.mjs'), /Refusing/)
  assert.throws(() => validateWritePath(''), /empty/)
})

test('branches are forced onto agent/ and the default branch is refused', () => {
  assert.equal(validateBranchName('fix-qa'), 'agent/fix-qa')
  assert.equal(validateBranchName('agent/fix-qa'), 'agent/fix-qa')
  assert.throws(() => validateBranchName('agent/main'), /default branch/)
  assert.throws(() => validateBranchName('agent/'), /must look like/)
})

test('credential-shaped content is refused before it can be committed', () => {
  assert.equal(detectSecret('const x = 1'), null)
  assert.equal(detectSecret('sk-thirdeye-abcdefgh12345'), 'our api key')
  assert.equal(detectSecret('AKIAIOSFODNN7EXAMPLE'), 'aws access key')
  assert.equal(detectSecret('-----BEGIN RSA PRIVATE KEY-----'), 'private key block')
  assert.throws(
    () => validateWriteBatch([{ path: 'src/a.ts', content: 'const k = "sk-thirdeye-abcdefgh12345"' }]),
    /looks like it contains/
  )
})

test('the batch is capped by file count', () => {
  const many = Array.from({ length: WRITE_MAX_FILES + 1 }, (_, i) => ({ path: `src/f${i}.ts`, content: 'x' }))
  assert.throws(() => validateWriteBatch(many), /Too many files/)
  assert.throws(() => validateWriteBatch([]), /at least one file/)
})
