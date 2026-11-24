import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWebSearch, isWebSearchEnabled, WebSearchError, WEB_SEARCH_TOOL } from '../src/agents/web-search.js'

const KEY = 'stub_search_key_never_returned'

function stub(status: number, body: any) {
  const calls: { url: string; init: any }[] = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as any
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

test('brave results are normalised to one shape', async () => {
  const { fetchImpl, calls } = stub(200, {
    web: { results: [{ title: 'Base docs', url: 'https://docs.base.org', description: 'Base is an L2' }] },
  })
  const out = await runWebSearch({ query: 'base l2', count: 3 }, { fetchImpl, apiKey: KEY, provider: 'brave' })
  assert.equal(out.results.length, 1)
  assert.deepEqual(out.results[0], { title: 'Base docs', url: 'https://docs.base.org', snippet: 'Base is an L2' })
  assert.match(calls[0].url, /api\.search\.brave\.com/)
  assert.match(calls[0].url, /count=3/)
  assert.equal(calls[0].init.headers['X-Subscription-Token'], KEY)
})

test('tavily results are normalised and use a bearer token', async () => {
  const { fetchImpl, calls } = stub(200, { results: [{ title: 'Neon', url: 'https://neon.tech', content: 'Postgres' }] })
  const out = await runWebSearch({ query: 'neon postgres' }, { fetchImpl, apiKey: KEY, provider: 'tavily' })
  assert.equal(out.results[0].snippet, 'Postgres')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`)
})

test('count is clamped to 1..10 and defaults to 5', async () => {
  const a = stub(200, { results: [] })
  await runWebSearch({ query: 'x', count: 999 }, { fetchImpl: a.fetchImpl, apiKey: KEY, provider: 'tavily' })
  assert.equal(JSON.parse(a.calls[0].init.body).max_results, 10)
  const b = stub(200, { results: [] })
  await runWebSearch({ query: 'x' }, { fetchImpl: b.fetchImpl, apiKey: KEY, provider: 'tavily' })
  assert.equal(JSON.parse(b.calls[0].init.body).max_results, 5)
})

test('an unknown argument is refused by name, before any request', async () => {
  const { fetchImpl, calls } = stub(200, { results: [] })
  await assert.rejects(
    () => runWebSearch({ query: 'x', url: 'https://evil.test' }, { fetchImpl, apiKey: KEY }),
    (e: any) => e instanceof WebSearchError && /does not accept the argument "url"/.test(e.message),
  )
  assert.equal(calls.length, 0)
})

test('a missing key fails before any request', async () => {
  const { fetchImpl, calls } = stub(200, { results: [] })
  await assert.rejects(() => runWebSearch({ query: 'x' }, { fetchImpl, apiKey: '' }), /WEB_SEARCH_API_KEY is not set/)
  assert.equal(calls.length, 0)
})

test('an empty or oversized query is refused', async () => {
  const { fetchImpl } = stub(200, { results: [] })
  await assert.rejects(() => runWebSearch({ query: '   ' }, { fetchImpl, apiKey: KEY }), /non-empty query/)
  await assert.rejects(() => runWebSearch({ query: 'a'.repeat(401) }, { fetchImpl, apiKey: KEY }), /longer than 400/)
})

test('an upstream failure names the provider and leaks nothing', async () => {
  const { fetchImpl } = stub(401, { error: 'bad key' })
  await assert.rejects(
    () => runWebSearch({ query: 'x' }, { fetchImpl, apiKey: KEY, provider: 'brave' }),
    (e: any) => {
      assert.match(e.message, /brave returned HTTP 401/)
      assert.equal(e.message.includes(KEY), false, 'the key must never appear in an error')
      return true
    },
  )
})

test('the tool stays disabled unless the deployment opts in', () => {
  assert.equal(isWebSearchEnabled({} as any), false)
  assert.equal(isWebSearchEnabled({ WEB_SEARCH_ENABLED: 'false' } as any), false)
  assert.equal(isWebSearchEnabled({ WEB_SEARCH_ENABLED: 'TRUE' } as any), true)
})

test('the published tool schema matches what the handler accepts', () => {
  assert.equal(WEB_SEARCH_TOOL.name, 'web_search')
  assert.deepEqual(Object.keys(WEB_SEARCH_TOOL.parameters.properties).sort(), ['count', 'query'])
  assert.deepEqual(WEB_SEARCH_TOOL.parameters.required, ['query'])
})
