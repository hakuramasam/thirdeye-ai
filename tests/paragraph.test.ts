import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDraft,
  getMe,
  paragraphConfigured,
  paragraphRequest,
  redactKey,
} from '../src/lib/paragraph.js'

const KEY = 'para_test_key_do_not_leak_0123456789'

/** Minimal fetch double: records the call, answers with a canned response. */
function stubFetch(response: { status?: number; body?: unknown; raw?: string }) {
  const calls: Array<{ url: string; init: any }> = []
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    const status = response.status ?? 200
    const text = response.raw ?? JSON.stringify(response.body ?? {})
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function withKey<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> | T {
  const prev = process.env.PARAGRAPH_API_KEY
  if (value === undefined) delete process.env.PARAGRAPH_API_KEY
  else process.env.PARAGRAPH_API_KEY = value
  const restore = () => {
    if (prev === undefined) delete process.env.PARAGRAPH_API_KEY
    else process.env.PARAGRAPH_API_KEY = prev
  }
  try {
    const out = fn() as any
    return out && typeof out.then === 'function' ? out.finally(restore) : (restore(), out)
  } catch (e) {
    restore()
    throw e
  }
}

test('a missing key is a clean refusal, not a request', async () => {
  await withKey(undefined, async () => {
    assert.equal(paragraphConfigured(), false)
    const { impl, calls } = stubFetch({ body: {} })
    const res = await getMe({ fetchImpl: impl })
    assert.equal(res.ok, false)
    assert.equal((res as any).code, 'not_configured')
    assert.equal(calls.length, 0, 'must not call Paragraph without a key')
  })
})

test('the key travels as a bearer token from the environment', async () => {
  await withKey(KEY, async () => {
    assert.equal(paragraphConfigured(), true)
    const { impl, calls } = stubFetch({ body: { id: 'pub_1', name: 'Thirdeye', slug: 'thirdeye' } })
    const res = await getMe({ fetchImpl: impl })
    assert.equal(res.ok, true)
    assert.equal((res as any).data.name, 'Thirdeye')
    assert.equal(calls[0].url, 'https://public.api.paragraph.com/api/v1/me')
    assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`)
    assert.equal(calls[0].init.method, 'GET')
  })
})

test('a single { data } wrapper is unwrapped', async () => {
  await withKey(KEY, async () => {
    const { impl } = stubFetch({ body: { data: { id: 'pub_2' } } })
    const res = await paragraphRequest<{ id: string }>('/v1/me', { fetchImpl: impl })
    assert.equal(res.ok, true)
    assert.deepEqual((res as any).data, { id: 'pub_2' })
  })
})

test('an auth failure maps to unauthorized without echoing the key', async () => {
  await withKey(KEY, async () => {
    const { impl } = stubFetch({ status: 401, body: { error: { message: `bad token ${KEY}` } } })
    const res = await getMe({ fetchImpl: impl })
    assert.equal(res.ok, false)
    assert.equal((res as any).code, 'unauthorized')
    assert.equal((res as any).status, 401)
    assert.ok(!(res as any).message.includes(KEY), 'message must not contain the key')
    assert.ok((res as any).message.includes('[redacted]'))
  })
})

test('rate limits and 404s get their own codes', async () => {
  await withKey(KEY, async () => {
    const limited = await getMe({ fetchImpl: stubFetch({ status: 429, body: { message: 'slow down' } }).impl })
    assert.equal((limited as any).code, 'rate_limited')
    const missing = await paragraphRequest('/v1/posts/nope', { fetchImpl: stubFetch({ status: 404, body: {} }).impl })
    assert.equal((missing as any).code, 'not_found')
  })
})

test('a network failure is reported, never thrown', async () => {
  await withKey(KEY, async () => {
    const impl = (async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const res = await getMe({ fetchImpl: impl })
    assert.equal(res.ok, false)
    assert.equal((res as any).code, 'network_error')
  })
})

test('draft creation posts JSON and stays on the content endpoint', async () => {
  await withKey(KEY, async () => {
    const { impl, calls } = stubFetch({ body: { id: 'content_1', status: 'draft' } })
    const res = await createDraft({ title: 'Peer routing ships today', body: 'Measured, not guessed.' }, { fetchImpl: impl })
    assert.equal(res.ok, true)
    assert.equal(calls[0].url, 'https://public.api.paragraph.com/api/v1/content')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers['content-type'], 'application/json')
    assert.equal(JSON.parse(calls[0].init.body).title, 'Peer routing ships today')
  })
})

test('redaction strips the key and stray bearer headers', () => {
  const key = 'abcdef1234567890'
  assert.equal(redactKey(`token was ${key}`, key), 'token was [redacted]')
  assert.equal(redactKey('Authorization: Bearer abcdef1234567890xyz', key), 'Authorization: Bearer [redacted]')
  assert.ok(redactKey('x'.repeat(900), key).length <= 400)
})
