process.env.PGLITE_DIR = 'memory://'

import test from 'node:test'
import assert from 'node:assert/strict'

const { describeSiweParseFailure } = await import('../src/routes/auth.js')

const ADDRESS = '0x9f8a1c2d3e4b5a69788796a5b4c3d2e1f0091827'
const NONCE = 'deadbeefcafe1234deadbeefcafe1234'
const RAW = `localhost wants you to sign in with your Ethereum account:\n${ADDRESS}\n\nSign in\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 8453\nNonce: ${NONCE}\nIssued At: 2026-11-09T12:00:00Z`

test('the failure diagnostic never carries the raw message, address or nonce', () => {
  const out = describeSiweParseFailure(RAW, new Error('Invalid nonce field'))
  const serialised = JSON.stringify(out)
  assert.ok(!serialised.includes(ADDRESS), 'address leaked into the log payload')
  assert.ok(!serialised.includes(NONCE), 'nonce leaked into the log payload')
  assert.ok(!serialised.includes('wants you to sign in'), 'message body leaked into the log payload')
  assert.ok(!serialised.includes('http://localhost:5173'), 'URI leaked into the log payload')
})

test('the diagnostic still says something useful about why it failed', () => {
  const out = describeSiweParseFailure(RAW, new Error('Invalid nonce field'))
  assert.equal(out.code, 'siwe_parse_failed')
  assert.equal(out.length, RAW.length)
  assert.equal(out.has_address, true)
  assert.equal(out.has_nonce, true)
  assert.equal(out.parser_error, 'Error:nonce_unparseable')
})

test('CRLF mangling is distinguishable from a missing field, without the content', () => {
  const crlf = RAW.replace(/\n/g, '\r\n')
  const out = describeSiweParseFailure(crlf, new Error('bad format'))
  assert.equal(out.has_crlf, true)
  assert.equal(out.has_nonce, true)
  assert.ok(!JSON.stringify(out).includes(NONCE))
})

test('a message with no address or nonce reports absence rather than echoing input', () => {
  const out = describeSiweParseFailure('garbage input', new Error('nope'))
  assert.equal(out.has_address, false)
  assert.equal(out.has_nonce, false)
  assert.equal(out.length, 13)
})
