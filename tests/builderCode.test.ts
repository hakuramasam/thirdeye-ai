process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_BUILDER_CODE,
  ERC8021_TRAILER,
  builderCodeFrom,
  hasAttribution,
  withAttribution,
} from '../src/lib/builderCode.js'

const calldata = '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001' as const

test('the operator-nominated code is the default', () => {
  assert.equal(DEFAULT_BUILDER_CODE, 'bc_qt11jd66')
  assert.equal(builderCodeFrom({}), 'bc_qt11jd66')
  assert.equal(builderCodeFrom({ BUILDER_CODE: '  bc_qt11jd66  ' }), 'bc_qt11jd66')
})

test('a value that is not a builder code is refused rather than concatenated into calldata', () => {
  assert.equal(builderCodeFrom({ BUILDER_CODE: 'bc_SHORT' }), null)
  assert.equal(builderCodeFrom({ BUILDER_CODE: 'not-a-code' }), null)
  assert.equal(builderCodeFrom({ BUILDER_CODE: 'bc_qt11jd6' }), null)
})

test('an empty BUILDER_CODE switches attribution off deliberately', () => {
  assert.equal(builderCodeFrom({ BUILDER_CODE: '' }), null)
  assert.equal(withAttribution(calldata, { BUILDER_CODE: '' }), calldata)
})

test('the suffix ends in the ERC-8021 trailer Base documents', () => {
  const out = withAttribution(calldata, {})
  assert.ok(out)
  assert.ok(out.toLowerCase().endsWith(ERC8021_TRAILER), 'last 16 bytes must be 0x8021 repeating')
  assert.ok(out.startsWith(calldata), 'original calldata must be preserved as a prefix')
})

test('the code itself is embedded as ASCII', () => {
  const out = withAttribution(calldata, {})!
  const hex = Buffer.from('bc_qt11jd66', 'utf8').toString('hex')
  assert.ok(out.toLowerCase().includes(hex), 'the builder code must appear verbatim in the suffix')
  // length byte (0x0b = 11) and schema id 0 follow the codes
  assert.ok(out.toLowerCase().includes(`${hex}0b00`), 'schema 0 layout: codes, codesLength, schemaId')
})

test('appending twice is a no-op, so a retry cannot pay for two suffixes', () => {
  const once = withAttribution(calldata, {})!
  const twice = withAttribution(once, {})!
  assert.equal(twice, once)
  assert.ok(hasAttribution(once))
  assert.equal(hasAttribution(calldata), false)
})

test('a bare transfer keeps its empty calldata', () => {
  assert.equal(withAttribution(undefined, {}), undefined)
  assert.equal(withAttribution('0x', {}), '0x')
})

test('a different code overrides the default', () => {
  const out = withAttribution(calldata, { BUILDER_CODE: 'bc_vdpt9spc' })!
  const hex = Buffer.from('bc_vdpt9spc', 'utf8').toString('hex')
  assert.ok(out.toLowerCase().includes(hex))
  assert.ok(out.toLowerCase().endsWith(ERC8021_TRAILER))
})
