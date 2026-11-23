/**
 * The four role tools, exercised without a network or a child process.
 *
 * Each tool gets a happy path, a refusal and a boundary case, because those are the three ways
 * a model reaches it: correctly, with an invented key, and against an input that must say no.
 * The last test proves that no tool's JSON result can carry a token back to the model.
 *
 * Every stub is injected through RoleToolDeps, so a failure here means the tool's own logic is
 * wrong, not that GitHub or Vercel was unreachable.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ROLE_TOOLS,
  runTests,
  readCheckRuns,
  openPullRequest,
  readDeployStatus,
  type ExecFileFn,
  type RoleToolDeps,
} from '../src/agents/role-tools.js'

const GITHUB_TOKEN = 'ghs_stub_github_token_never_returned'
const VERCEL_TOKEN = 'vercel_stub_token_never_returned'
const SHA = 'a'.repeat(40)

const TAP_RED = [
  'TAP version 13',
  'ok 1 - a writable path passes',
  'not ok 2 - a traversal is refused',
  '1..2',
  '# tests 2',
  '# pass 1',
  '# fail 1',
  '# skipped 0',
].join('\n')

const TAP_GREEN = ['ok 1 - one', 'ok 2 - two', '# tests 2', '# pass 2', '# fail 0', '# skipped 0'].join('\n')

type Route = { match: RegExp; status?: number; body?: unknown }

/** A fetch stub that records every request and fails loudly on one it did not expect. */
function stubFetch(routes: Route[]) {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = []
  const fn = async (url: unknown, init: any = {}) => {
    seen.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? undefined : String(init.body),
    })
    const route = routes.find((r) => r.match.test(String(url)))
    if (!route) throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`)
    return new Response(JSON.stringify(route.body ?? null), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl: fn as unknown as typeof fetch, seen }
}

/** An exec stub: records the argv, returns the TAP text as stdout, never spawns anything. */
function stubExec(stdout: string, opts: { code?: number; stderr?: string } = {}) {
  const seen: Array<{ file: string; args: string[]; options: any }> = []
  const exec: ExecFileFn = async (file, args, options) => {
    seen.push({ file, args: [...args], options })
    if (opts.code && opts.code !== 0) {
      const err: any = new Error(`Command failed with exit code ${opts.code}`)
      err.code = opts.code
      err.stdout = stdout
      err.stderr = opts.stderr ?? ''
      throw err
    }
    return { stdout, stderr: opts.stderr ?? '' }
  }
  return { exec, seen }
}

const deps = (extra: Partial<RoleToolDeps> = {}): RoleToolDeps => ({
  githubToken: GITHUB_TOKEN,
  vercelToken: VERCEL_TOKEN,
  ...extra,
})

describe('runTests', () => {
  it('parses the TAP summary into pass/fail and marks a red suite not ok', async () => {
    const { exec, seen } = stubExec(TAP_RED, { code: 1 })
    const res = await runTests({ files: ['tests/role-tools.test.ts'] }, deps({ exec }))

    assert.equal(res.ok, false)
    assert.equal(res.pass, 1)
    assert.equal(res.fail, 1)
    assert.match(res.output, /# fail 1/)
    // The command is npx tsx --test <file>, never a shell string.
    assert.equal(seen.length, 1)
    assert.equal(seen[0].file, 'npx')
    assert.deepEqual(seen[0].args, ['tsx', '--test', 'tests/role-tools.test.ts'])
    assert.equal(seen[0].options.shell, false)
    assert.equal(seen[0].options.timeout, 180_000)
  })

  it('marks a green suite ok and runs the whole suite when no files are named', async () => {
    const { exec, seen } = stubExec(TAP_GREEN)
    const res = await runTests({}, deps({ exec }))

    assert.equal(res.ok, true)
    assert.equal(res.pass, 2)
    assert.equal(res.fail, 0)
    assert.deepEqual(seen[0].args, ['tsx', '--test'])
  })

  it('rejects an unknown argument key and names it', async () => {
    await assert.rejects(
      () => runTests({ files: ['tests/role-tools.test.ts'], timeout_ms: 5 } as any, deps()),
      /unknown argument 'timeout_ms'/
    )
  })

  it('refuses a traversal path and a path outside tests/', async () => {
    await assert.rejects(() => runTests({ files: ['tests/../src/index.ts'] }, deps()), /contains '\.\.'/)
    await assert.rejects(() => runTests({ files: ['src/index.ts'] }, deps()), /is not under tests\//)
  })
})

describe('readCheckRuns', () => {
  it('builds the check-runs URL from the stub and reports allGreen true', async () => {
    const { fetchImpl, seen } = stubFetch([
      {
        match: /commits\/a{40}\/check-runs$/,
        body: {
          check_runs: [
            { name: 'build', status: 'completed', conclusion: 'success' },
            { name: 'test', status: 'completed', conclusion: 'success' },
          ],
        },
      },
    ])
    const res = await readCheckRuns({ owner: 'hakuramasam', repo: 'thirdeye-ai', sha: SHA }, deps({ fetch: fetchImpl }))

    assert.equal(seen[0].url, `https://api.github.com/repos/hakuramasam/thirdeye-ai/commits/${SHA}/check-runs`)
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].headers.authorization, `Bearer ${GITHUB_TOKEN}`)
    assert.equal(res.sha, SHA)
    assert.deepEqual(res.checks, [
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'success' },
    ])
    assert.equal(res.allGreen, true)
    // The result is the typed object, not the header map.
    assert.equal(JSON.stringify(res).includes(GITHUB_TOKEN), false)
  })

  it('reports allGreen false when a check is red or still running', async () => {
    const { fetchImpl } = stubFetch([
      {
        match: /check-runs$/,
        body: {
          check_runs: [
            { name: 'build', status: 'completed', conclusion: 'success' },
            { name: 'test', status: 'completed', conclusion: 'failure' },
            { name: 'deploy', status: 'in_progress', conclusion: null },
          ],
        },
      },
    ])
    const res = await readCheckRuns({ owner: 'o', repo: 'r', sha: SHA }, deps({ fetch: fetchImpl }))
    assert.equal(res.allGreen, false)
    assert.equal(res.checks.length, 3)
  })

  it('refuses a sha that is not 40 hex characters', async () => {
    await assert.rejects(
      () => readCheckRuns({ owner: 'o', repo: 'r', sha: 'deadbeef' }, deps()),
      /not a 40-character hex commit sha/
    )
    await assert.rejects(
      () => readCheckRuns({ owner: 'o', repo: 'r', sha: 'z'.repeat(40) }, deps()),
      /not a 40-character hex commit sha/
    )
  })
})

describe('openPullRequest', () => {
  it('refuses head === base without calling the network', async () => {
    const { fetchImpl, seen } = stubFetch([])
    await assert.rejects(
      () => openPullRequest({ owner: 'o', repo: 'r', head: 'main', base: 'main', title: 'x' }, deps({ fetch: fetchImpl })),
      /head and base are both 'main'/
    )
    assert.equal(seen.length, 0)
  })

  it('POSTs the pull request and returns the number from the stub', async () => {
    const { fetchImpl, seen } = stubFetch([
      { match: /\/pulls$/, body: { number: 42, html_url: 'https://github.com/o/r/pull/42', draft: false } },
    ])
    const res = await openPullRequest(
      { owner: 'o', repo: 'r', head: 'feat/role-tools', base: 'main', title: 'Add role tools', body: 'why' },
      deps({ fetch: fetchImpl })
    )

    assert.equal(seen[0].url, 'https://api.github.com/repos/o/r/pulls')
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].headers.authorization, `Bearer ${GITHUB_TOKEN}`)
    assert.deepEqual(JSON.parse(String(seen[0].body)), {
      title: 'Add role tools',
      head: 'feat/role-tools',
      base: 'main',
      body: 'why',
    })
    assert.deepEqual(res, { number: 42, url: 'https://github.com/o/r/pull/42', draft: false })
  })
})

describe('readDeployStatus', () => {
  it('returns the domains from the stub for the named project', async () => {
    const { fetchImpl, seen } = stubFetch([
      {
        match: /v9\/projects\/thirdeye-ai\/domains$/,
        body: {
          domains: [
            { name: 'thirdeye.ai', verified: true },
            { name: 'staging.thirdeye.ai', verified: false },
          ],
        },
      },
    ])
    const res = await readDeployStatus({ project: 'thirdeye-ai' }, deps({ fetch: fetchImpl }))

    assert.equal(seen[0].url, 'https://api.vercel.com/v9/projects/thirdeye-ai/domains')
    assert.equal(seen[0].headers.authorization, `Bearer ${VERCEL_TOKEN}`)
    assert.deepEqual(res, {
      project: 'thirdeye-ai',
      domains: [
        { name: 'thirdeye.ai', verified: true },
        { name: 'staging.thirdeye.ai', verified: false },
      ],
    })
  })
})

describe('registry', () => {
  it('registers exactly the four role tools by their model-facing names', () => {
    assert.deepEqual(
      ROLE_TOOLS.map((t) => t.name),
      ['run_tests', 'read_check_runs', 'open_pull_request', 'read_deploy_status']
    )
    for (const tool of ROLE_TOOLS) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20)
      assert.equal(typeof tool.handler, 'function')
    }
  })

  it('never returns a token in any handler JSON result', async () => {
    const { fetchImpl } = stubFetch([
      { match: /check-runs$/, body: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } },
      { match: /\/pulls$/, body: { number: 7, html_url: 'https://github.com/o/r/pull/7', draft: false } },
      { match: /domains$/, body: { domains: [{ name: 'thirdeye.ai', verified: true }] } },
    ])
    const { exec } = stubExec(TAP_GREEN)
    const shared = deps({ fetch: fetchImpl, exec })

    const results = [
      await runTests({ files: ['tests/role-tools.test.ts'] }, shared),
      await readCheckRuns({ owner: 'o', repo: 'r', sha: SHA }, shared),
      await openPullRequest({ owner: 'o', repo: 'r', head: 'feat/x', base: 'main', title: 't' }, shared),
      await readDeployStatus({ project: 'thirdeye-ai' }, shared),
    ]

    for (const result of results) {
      const json = JSON.stringify(result)
      assert.equal(json.includes(GITHUB_TOKEN), false, 'a GitHub token reached a tool result')
      assert.equal(json.includes(VERCEL_TOKEN), false, 'a Vercel token reached a tool result')
      assert.equal(/authorization/i.test(json), false, 'a header map reached a tool result')
    }
  })
})
