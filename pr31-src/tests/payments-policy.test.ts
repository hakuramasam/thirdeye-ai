import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSellerAllowed,
  effectivePerCallCapMicros,
  DEFAULT_PER_CALL_CAP_MICROS,
  HARD_PER_CALL_CAP_MICROS,
} from '../src/agents/payments-policy.js'

test('empty allowlist denies every payment (fail closed)', () => {
  const v = checkSellerAllowed('https://api.example.com/price', [])
  assert.equal(v.ok, false)
  assert.match((v as any).reason, /No sellers allowlisted/)
  assert.equal(checkSellerAllowed('https://api.example.com/x', null).ok, false)
})

test('exact host and wildcard subdomains are allowed', () => {
  assert.equal(checkSellerAllowed('https://api.example.com/price', ['api.example.com']).ok, true)
  assert.equal(checkSellerAllowed('https://a.api.example.com/price', ['*.example.com']).ok, true)
  assert.equal(checkSellerAllowed('https://deep.a.api.example.com/p', ['*.example.com']).ok, true)
})

test('lookalike hosts and suffix tricks are rejected', () => {
  assert.equal(checkSellerAllowed('https://evil-example.com/p', ['example.com']).ok, false)
  assert.equal(checkSellerAllowed('https://example.com.evil.io/p', ['example.com']).ok, false)
  assert.equal(checkSellerAllowed('https://api.example.com.evil.io/p', ['*.example.com']).ok, false)
  assert.equal(checkSellerAllowed('https://api.example.com/p', ['other.com']).ok, false)
})

test('non-http schemes are refused outright', () => {
  assert.equal(checkSellerAllowed('file:///etc/passwd', ['example.com']).ok, false)
  assert.equal(checkSellerAllowed('javascript:alert(1)', ['example.com']).ok, false)
})

test('per-call cap takes the smallest of agent, requested and platform ceiling', () => {
  assert.equal(effectivePerCallCapMicros(5000, 50000), 5000)
  assert.equal(effectivePerCallCapMicros(500000, 20000), 20000)
  assert.equal(effectivePerCallCapMicros(undefined, undefined), DEFAULT_PER_CALL_CAP_MICROS)
  assert.equal(effectivePerCallCapMicros(99_000_000, 99_000_000), HARD_PER_CALL_CAP_MICROS)
  // a runaway loop cannot raise its own ceiling by asking for more
  assert.ok(effectivePerCallCapMicros(20000, HARD_PER_CALL_CAP_MICROS) <= 20000)
})
