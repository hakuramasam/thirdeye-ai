// Rotation tests need a master key and control over the previous one, so set both before import.
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-0001'
process.env.MASTER_KEY = 'test-master-key-current-value-000000000001'
delete process.env.MASTER_KEY_PREVIOUS
process.env.PGLITE_DIR = 'memory://'

import test from 'node:test'
import assert from 'node:assert/strict'

const { encryptSecret, decryptSecret, decryptSecretDetailed, reencryptSecret, SecretDecryptError } = await import(
  '../src/lib/env.js'
)

const PLAIN = 'sk-live-byok-secret-value-1234567890'

test('a secret round-trips and is stored under a versioned envelope', () => {
  const ct = encryptSecret(PLAIN)
  assert.ok(ct.startsWith('v1.'), 'ciphertext should carry a version prefix')
  assert.equal(ct.split('.').length, 4)
  assert.ok(!ct.includes(PLAIN), 'ciphertext must not contain the plaintext')
  assert.equal(decryptSecret(ct), PLAIN)
})

test('the same plaintext encrypts to different ciphertext each time', () => {
  const a = encryptSecret(PLAIN)
  const b = encryptSecret(PLAIN)
  assert.notEqual(a, b, 'a reused IV would make these identical')
  assert.equal(decryptSecret(a), decryptSecret(b))
})

test('a tampered ciphertext fails with a classified error, not a leaked one', () => {
  const ct = encryptSecret(PLAIN)
  const parts = ct.split('.')
  const flipped = parts[3].slice(0, -2) + (parts[3].slice(-2) === 'AA' ? 'BB' : 'AA')
  const tampered = [parts[0], parts[1], parts[2], flipped].join('.')
  try {
    decryptSecret(tampered)
    assert.fail('tampered ciphertext decrypted')
  } catch (e: any) {
    assert.equal(e.name, 'SecretDecryptError')
    assert.equal(e.code, 'decryption_failed')
    assert.ok(!String(e.message).includes(PLAIN), 'error must not echo plaintext')
    assert.ok(!String(e.message).includes(parts[3]), 'error must not echo ciphertext')
  }
})

test('a malformed payload is distinguished from a wrong key', () => {
  for (const bad of ['', 'not-a-payload', 'v1.only.two', 'v1.a..c']) {
    try {
      decryptSecret(bad)
      assert.fail(`should have thrown for ${JSON.stringify(bad)}`)
    } catch (e: any) {
      assert.ok(e instanceof SecretDecryptError)
      assert.equal(e.code, 'malformed_payload')
    }
  }
})

test('legacy three-part ciphertext from before versioning still decrypts', () => {
  const ct = encryptSecret(PLAIN)
  const legacy = ct.split('.').slice(1).join('.') // strip the v1 prefix
  assert.equal(legacy.split('.').length, 3)
  const out = decryptSecretDetailed(legacy)
  assert.equal(out.plain, PLAIN)
  assert.equal(out.rotated, false, 'a legacy payload under the current key is not a rotation')
})

test('the previous key decrypts old rows and reports that they need re-wrapping', () => {
  const current = process.env.MASTER_KEY!
  const previous = 'test-master-key-previous-value-00000000001'
  let oldCiphertext = ''
  try {
    // Encrypt under what will become the "previous" key.
    process.env.MASTER_KEY = previous
    oldCiphertext = encryptSecret(PLAIN)
  } finally {
    process.env.MASTER_KEY = current
    delete process.env.MASTER_KEY_PREVIOUS
  }

  assert.throws(() => decryptSecret(oldCiphertext), /cannot be read/, 'must not read under the new key alone')

  process.env.MASTER_KEY_PREVIOUS = previous
  try {
    const out = decryptSecretDetailed(oldCiphertext)
    assert.equal(out.plain, PLAIN)
    assert.equal(out.rotated, true)

    const migrated = reencryptSecret(oldCiphertext)
    assert.equal(migrated.plain, PLAIN)
    assert.equal(migrated.rotated, true)
    assert.ok(migrated.ciphertext.startsWith('v1.'))
    oldCiphertext = migrated.ciphertext
  } finally {
    delete process.env.MASTER_KEY_PREVIOUS
  }

  // After rotation the row is readable by the current key alone, with no previous key configured.
  assert.equal(decryptSecret(oldCiphertext), PLAIN)
})

test('with no previous key configured, an unreadable payload stays unreadable', () => {
  const current = process.env.MASTER_KEY!
  const previous = 'test-master-key-previous-value-00000000001'
  let oldCiphertext = ''
  try {
    process.env.MASTER_KEY = previous
    oldCiphertext = encryptSecret(PLAIN)
  } finally {
    process.env.MASTER_KEY = current
    delete process.env.MASTER_KEY_PREVIOUS
  }

  try {
    decryptSecret(oldCiphertext)
    assert.fail('should not decrypt without the previous key')
  } catch (e: any) {
    assert.equal(e.code, 'decryption_failed')
  }
})
