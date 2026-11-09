import test from 'node:test'
import assert from 'node:assert/strict'
import { paidFetch } from '../src/agents/x402.js'

// The SEC-002 x402 issue: the unpaid probe used to run before any destination policy, so a
// user-supplied URL could reach loopback or private space. These assert the probe is refused
// rather than attempted, which needs no network because validation happens before connecting.
test('the x402 probe refuses loopback before making a request', async () => {
  const r = await paidFetch('http://127.0.0.1:8080/paid')
  assert.equal(r.paid, false)
  assert.ok(r.blocked, 'expected a blocked result')
  assert.match(String(r.blocked?.reason), /blocked_destination/)
})

test('the x402 probe refuses the cloud metadata address', async () => {
  const r = await paidFetch('http://169.254.169.254/latest/meta-data/')
  assert.equal(r.paid, false)
  assert.match(String(r.blocked?.reason), /blocked_destination/)
})

test('the x402 probe refuses private RFC1918 space', async () => {
  const r = await paidFetch('http://10.0.0.5/invoice')
  assert.equal(r.paid, false)
  assert.match(String(r.blocked?.reason), /blocked_destination/)
})

test('the x402 probe refuses a non-http scheme', async () => {
  const r = await paidFetch('file:///etc/passwd')
  assert.equal(r.paid, false)
  assert.ok(r.blocked)
})
