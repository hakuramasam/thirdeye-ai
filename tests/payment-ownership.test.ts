import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSenderOwnership } from '../src/payments/verify.js'

const ALICE = '0x2222222222222222222222222222222222222222'
const MALLORY = '0x9999999999999999999999999999999999999999'

test('a transfer from the signed-in wallet is claimable', () => {
  const verdict = checkSenderOwnership({ sender: ALICE, sessionWallet: ALICE })
  assert.equal(verdict.ok, true)
})

test('address case does not decide ownership', () => {
  const verdict = checkSenderOwnership({ sender: '0x' + ALICE.slice(2).toUpperCase(), sessionWallet: ALICE })
  assert.equal(verdict.ok, true)
})

test("another user's transfer cannot be claimed, which is the SEC-001 gap", () => {
  const verdict = checkSenderOwnership({ sender: ALICE, sessionWallet: MALLORY })
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.code, 'sender_not_owner')
})

test('an unreadable sender is refused rather than waved through', () => {
  for (const sender of ['', null, undefined, '0x123', 'not-an-address']) {
    const verdict = checkSenderOwnership({ sender: sender as any, sessionWallet: ALICE })
    assert.equal(verdict.ok, false)
    if (!verdict.ok) assert.equal(verdict.code, 'sender_missing')
  }
})

test('an account with no registered wallet cannot claim anything', () => {
  const verdict = checkSenderOwnership({ sender: ALICE, sessionWallet: '' })
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.code, 'sender_not_owner')
})

test('an intent owner cannot redirect a payment from a wallet they do not hold', () => {
  // Intent ownership is checked separately in the route; this pins that it is not sufficient.
  const verdict = checkSenderOwnership({ sender: MALLORY, sessionWallet: ALICE })
  assert.equal(verdict.ok, false)
})
