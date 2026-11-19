import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toRawUnits, fmtUsdc } from '../web/src/bridgeAmount.js'

test('a typed decimal becomes raw 6-decimal units without a float', () => {
  assert.equal(toRawUnits('25'), '25000000')
  assert.equal(toRawUnits('25.5'), '25500000')
  assert.equal(toRawUnits('0.000001'), '1')
  assert.equal(toRawUnits(' 12.34 '), '12340000')
})

test('an unusable amount is refused rather than rounded', () => {
  for (const bad of ['', '.', 'abc', '-5', '1e6', '1.2345678', '0', '0.000000']) {
    assert.equal(toRawUnits(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('display divides in integer space, so large values cannot lose precision', () => {
  assert.equal(fmtUsdc('25000000'), '25.00')
  assert.equal(fmtUsdc('1234567'), '1.23')
  assert.equal(fmtUsdc('1000000000000000000'), '1000000000000.00')
  assert.equal(fmtUsdc('junk'), '0.00')
})
