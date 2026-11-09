import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { privySigner, sponsorAttempts } from '../src/payments/signer.js'

// A real P-256 key, because the signer refuses to build an authorization header without one.
const TEST_KEY = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
})()

const ADDRESS = '0xb09f37a1110a126d63463Ec08a0C0B97612D90ab' as const
const TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const DATA = '0xdeadbeef'

/** Records every call so a test can assert the ladder actually walked (or did not). */
function stubFetch(replies: Array<{ ok: boolean; body: any }>) {
  const calls: Array<{ url: string; body: any }> = []
  const original = globalThis.fetch
  let i = 0
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    return { ok: reply.ok, status: reply.ok ? 200 : 400, json: async () => reply.body } as any
  }) as any
  return { calls, restore: () => { globalThis.fetch = original } }
}

const signer = (mode: 'off' | 'app' | 'user' | 'auto') =>
  privySigner('app-id', 'app-secret', 'wallet-id', ADDRESS, { keyId: 'k', privateKey: TEST_KEY }, mode)

const send = (s: ReturnType<typeof signer>) => s.sendTransaction({ to: TO as `0x${string}`, data: DATA, value: 0n, chainId: 8453 })

test('sponsor modes map to the request shapes Privy documents', () => {
  assert.deepEqual(sponsorAttempts('off'), [{}])
  assert.deepEqual(sponsorAttempts('app'), [{ sponsor: true }])
  assert.deepEqual(sponsorAttempts('user'), [{ sponsor: true, sponsor_options: { asset: 'usdc' } }])
  assert.equal(sponsorAttempts('auto').length, 3, 'app credits, then USDC gas, then plain')
  assert.deepEqual(sponsorAttempts('auto')[2], {}, 'the last resort is a plain transaction')
})

test('off mode sends one plain transaction and never asks for sponsorship', async () => {
  const stub = stubFetch([{ ok: true, body: { data: { hash: '0xabc' } } }])
  try {
    const hash = await send(signer('off'))
    assert.equal(hash, '0xabc')
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].body.sponsor, undefined)
    assert.equal(stub.calls[0].body.caip2, 'eip155:8453')
  } finally { stub.restore() }
})

test('auto walks past an unconfigured mode instead of failing the conversion', async () => {
  const stub = stubFetch([
    { ok: false, body: { error: 'Gas sponsorship is not configured for chain eip155:8453.' } },
    { ok: false, body: { error: 'User-pays token gas sponsorship is not configured for this app.' } },
    { ok: true, body: { data: { hash: '0xplain' } } },
  ])
  try {
    const hash = await send(signer('auto'))
    assert.equal(hash, '0xplain')
    assert.equal(stub.calls.length, 3)
    assert.deepEqual(stub.calls[0].body.sponsor, true)
    assert.deepEqual(stub.calls[1].body.sponsor_options, { asset: 'usdc' })
    assert.equal(stub.calls[2].body.sponsor, undefined)
  } finally { stub.restore() }
})

test('a policy denial is surfaced immediately, never retried as another payment mode', async () => {
  const stub = stubFetch([{ ok: false, body: { error: 'RPC request denied due to policy violation' } }])
  try {
    await assert.rejects(send(signer('auto')), /policy violation/)
    assert.equal(stub.calls.length, 1, 'retrying a denial would just be refused again')
  } finally { stub.restore() }
})

test('a sponsored send resolves the hash from the transaction it returns', async () => {
  const stub = stubFetch([
    { ok: true, body: { data: { transaction_id: 'tx-1', user_operation_hash: '0xuserop', hash: '' } } },
    { ok: true, body: { transaction_hash: '0xsettled' } },
  ])
  try {
    const hash = await send(signer('app'))
    assert.equal(hash, '0xsettled')
    assert.match(stub.calls[1].url, /\/v1\/transactions\/tx-1$/)
  } finally { stub.restore() }
})

test('an empty wallet surfaces the funding error rather than silently retrying', async () => {
  const stub = stubFetch([{ ok: false, body: { error: 'Provider reported insufficient funds.' } }])
  try {
    await assert.rejects(send(signer('auto')), /insufficient funds/)
    assert.equal(stub.calls.length, 1)
  } finally { stub.restore() }
})
