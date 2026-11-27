import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.GITHUB_TOKEN = 'test-github-token'
process.env.GITHUB_REPO = 'hakuramasam/thirdeye-ai'

const { runRepoTool, REPO_TOOL, STAGING_REPO_TOOL } = await import('../src/agents/repo-tools.js')
const TARGET_SHA = 'dd956e60524020d1e8218bd1652d1cab356d2414'

test('staging repo tool exposes a fixed diff operation without adding a caller-selected PR id', () => {
  const schema = REPO_TOOL.function.parameters as any
  assert.deepEqual(schema.properties.op.enum, ['list', 'read', 'search'])
  const stagingSchema = STAGING_REPO_TOOL.function.parameters as any
  assert.deepEqual(stagingSchema.properties.op.enum, ['list', 'read', 'diff'])
  assert.equal(stagingSchema.properties.pull_request, undefined)
})

test('fixed PR diff is fetched only after repository and exact head SHA are verified', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; accept: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const accept = headers.get('accept') || ''
    calls.push({ url, accept })
    if (url.endsWith('/pulls/116') && accept === 'application/vnd.github+json') {
      return new Response(JSON.stringify({
        base: { repo: { full_name: 'hakuramasam/thirdeye-ai' } },
        head: { sha: TARGET_SHA },
      }), { status: 200 })
    }
    if (url.endsWith('/pulls/116') && accept === 'application/vnd.github.diff') {
      return new Response('diff --git a/src/a.ts b/src/a.ts\n+export const value = 1\n', { status: 200 })
    }
    throw new Error('unexpected network request')
  }) as typeof fetch

  try {
    const result = await runRepoTool({ op: 'diff' }, {
      repo: 'hakuramasam/thirdeye-ai',
      ref: TARGET_SHA,
      reviewPrNumber: 116,
    })
    assert.match(result, /hakuramasam\/thirdeye-ai#116 at dd956e60524020d1e8218bd1652d1cab356d2414/)
    assert.match(result, /diff --git a\/src\/a.ts b\/src\/a.ts/)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].accept, 'application/vnd.github.diff')

    const denied = await runRepoTool({ op: 'diff' }, {
      repo: 'hakuramasam/thirdeye-ai',
      ref: TARGET_SHA,
    })
    assert.match(denied, /PR diff access is not enabled/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fixed PR diff refuses a mutable or mismatched head before downloading the patch', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({
      base: { repo: { full_name: 'hakuramasam/thirdeye-ai' } },
      head: { sha: 'different-commit' },
    }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await runRepoTool({ op: 'diff' }, {
      repo: 'hakuramasam/thirdeye-ai',
      ref: TARGET_SHA,
      reviewPrNumber: 116,
    })
    assert.match(result, /repository or head SHA does not match/)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
