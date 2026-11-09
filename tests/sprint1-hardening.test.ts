process.env.PGLITE_DIR = 'memory://'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { migrate, query, one } = await import('../src/db/index.js')
const { isPublicAddress, assertPublicUrl, guardedFetch, SsrfError } = await import('../src/lib/ssrf.js')
const {
  acquireScheduleLock,
  finishScheduleLock,
  cronSlotKey,
} = await import('../src/agents/schedule-lock.js')
const { runAgent } = await import('../src/agents/runner.js')
const { isDeniedPath, normalisePath, runRepoTool, hasRepoAccess } = await import('../src/agents/repo-tools.js')

describe('Sprint 1: SSRF guard', () => {
  it('classifies public and private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      assert.equal(isPublicAddress(ip), false, `${ip} must be blocked`)
    }
    for (const ip of ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::']) {
      assert.equal(isPublicAddress(ip), false, `${ip} must be blocked`)
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPublicAddress(ip), true, `${ip} must be allowed`)
    }
  })

  it('refuses schemes, credentials, low ports and internal hosts', async () => {
    const cases: Array<[string, string]> = [
      ['file:///etc/passwd', 'blocked_scheme'],
      ['gopher://example.com/', 'blocked_scheme'],
      ['http://user:pass@1.1.1.1/', 'blocked_credentials'],
      ['http://localhost/', 'blocked_host'],
      ['http://127.0.0.1/', 'blocked_address'],
      ['http://169.254.169.254/latest/meta-data/', 'blocked_address'],
      ['http://10.0.0.5/', 'blocked_address'],
      ['http://[::1]/', 'blocked_address'],
      ['http://1.1.1.1:22/', 'blocked_port'],
      ['not-a-url', 'invalid_url'],
    ]
    for (const [url, code] of cases) {
      await assert.rejects(assertPublicUrl(url), (e: any) => e instanceof SsrfError && e.code === code, `${url} should fail with ${code}`)
    }
  })

  it('allows a public literal address', async () => {
    const ok = await assertPublicUrl('https://1.1.1.1/dns-query')
    assert.equal(ok.addresses[0], '1.1.1.1')
  })

  describe('guardedFetch against a local server', () => {
    let server: any
    let port = 0
    const hits: string[] = []

    before(async () => {
      server = createServer((req, res) => {
        hits.push(String(req.url))
        if (req.url === '/redirect-out') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
          res.end()
          return
        }
        if (req.url === '/redirect-in') {
          res.writeHead(302, { location: '/second' })
          res.end()
          return
        }
        if (req.url === '/big') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('x'.repeat(5000))
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('hello')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      port = (server.address() as any).port
    })

    after(() => server?.close())

    it('blocks loopback without an allowlist', async () => {
      await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`), (e: any) => e.code === 'blocked_address')
    })

    it('fetches an allowlisted host and follows an in-host redirect', async () => {
      hits.length = 0
      const res = await guardedFetch(`http://127.0.0.1:${port}/redirect-in`, {}, { allowHosts: ['127.0.0.1'] })
      assert.equal(res.status, 200)
      assert.equal(res.body, 'hello')
      assert.deepEqual(res.redirects.length, 1)
    })

    it('refuses a redirect to a non-public address', async () => {
      await assert.rejects(
        guardedFetch(`http://127.0.0.1:${port}/redirect-out`, {}, { allowHosts: ['127.0.0.1'] }),
        (e: any) => e.code === 'blocked_address'
      )
    })

    it('truncates oversized bodies', async () => {
      const res = await guardedFetch(`http://127.0.0.1:${port}/big`, {}, { allowHosts: ['127.0.0.1'], maxBytes: 1000 })
      assert.equal(res.truncated, true)
      assert.ok(res.body.length <= 1000)
    })
  })
})

describe('Sprint 1: durable schedule lock', () => {
  let userId = ''
  let agentId = ''

  before(async () => {
    await migrate()
    userId = 'usr_lock_test'
    agentId = 'tdt_lock_test'
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, '0x5555555555555555555555555555555555555555', 'user') ON CONFLICT DO NOTHING`, [userId])
    await query(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, mcp_servers, x402_enabled, budget_usd_micros, max_steps)
       VALUES ($1, $2, 'lock-agent', 'sys', 'thirdeye-mock', '[]', false, 100000, 3) ON CONFLICT DO NOTHING`,
      [agentId, userId]
    )
  })

  it('gives one slot to exactly one caller', async () => {
    const key = 'cron:test-once'
    const first = await acquireScheduleLock(agentId, key, { runId: 'run-a' })
    assert.ok(first)
    assert.equal(first!.how, 'inserted')
    assert.equal(first!.runId, 'run-a')

    const second = await acquireScheduleLock(agentId, key, { runId: 'run-b' })
    assert.equal(second, null, 'a fresh lock must not be stealable')
  })

  it('never re-runs a completed slot, but steals a stale one', async () => {
    const doneKey = 'cron:test-done'
    const lock = await acquireScheduleLock(agentId, doneKey, { runId: 'run-c' })
    await finishScheduleLock(lock!.id, 'run-c', 'COMPLETED')
    assert.equal(await acquireScheduleLock(agentId, doneKey, { runId: 'run-d' }), null, 'COMPLETED is terminal')

    const staleKey = 'cron:test-stale'
    const stale = await acquireScheduleLock(agentId, staleKey, { runId: 'run-e' })
    await query(`UPDATE agent_schedule_lock SET lock_expires_at = now() - interval '1 hour' WHERE id = $1`, [stale!.id])
    const stolen = await acquireScheduleLock(agentId, staleKey, { runId: 'run-f' })
    assert.ok(stolen)
    assert.equal(stolen!.how, 'stolen')
    assert.equal(stolen!.runId, 'run-f')
  })

  it('makes a failed slot retryable only after back-off', async () => {
    const key = 'cron:test-failed'
    const lock = await acquireScheduleLock(agentId, key, { runId: 'run-g' })
    await finishScheduleLock(lock!.id, 'run-g', 'FAILED', { reason: 'boom' })
    assert.equal(await acquireScheduleLock(agentId, key, { runId: 'run-h' }), null, 'inside back-off window')
    await query(`UPDATE agent_schedule_lock SET lock_expires_at = now() - interval '1 minute' WHERE id = $1`, [lock!.id])
    const retry = await acquireScheduleLock(agentId, key, { runId: 'run-i' })
    assert.ok(retry)
  })

  it('keys slots per minute', () => {
    const a = cronSlotKey(new Date('2026-11-09T10:00:05Z'))
    const b = cronSlotKey(new Date('2026-11-09T10:00:55Z'))
    const c = cronSlotKey(new Date('2026-11-09T10:01:00Z'))
    assert.equal(a, b)
    assert.notEqual(a, c)
  })

  it('does not run or charge a replayed run id', async () => {
    const agent = await one(`SELECT * FROM agents WHERE id = $1`, [agentId])
    const user = await one(`SELECT * FROM users WHERE id = $1`, [userId])
    let calls = 0
    const fakeLlm = {
      async call() {
        calls++
        return { content: 'first answer', prompt_tokens: 1, completion_tokens: 1 }
      },
    }
    const first = await runAgent(agent, 'hi', user, { llm: fakeLlm, runId: 'replay-run-1' })
    assert.equal(first.status, 'success')
    assert.equal(first.tool_calls, 0)

    const second = await runAgent(agent, 'hi', user, { llm: fakeLlm, runId: 'replay-run-1' })
    assert.equal(second.replayed, true)
    assert.equal(second.output, 'first answer')
    assert.equal(calls, 1, 'the model must not be called twice for the same run id')
  })

  it('closes a run as error instead of leaving it running when a step throws', async () => {
    const agent = await one(`SELECT * FROM agents WHERE id = $1`, [agentId])
    const user = await one(`SELECT * FROM users WHERE id = $1`, [userId])
    const explodingLlm = {
      async call() {
        throw new Error('provider exploded')
      },
    }
    const res = await runAgent(agent, 'hi', user, { llm: explodingLlm, runId: 'explode-run-1' })
    assert.equal(res.status, 'error')
    assert.match(String(res.error), /provider exploded/)
    const row = await one(`SELECT status, error FROM agent_runs WHERE id = $1`, ['explode-run-1'])
    assert.equal(row.status, 'error')
    assert.match(String(row.error), /provider exploded/)
  })
})

describe('Sprint 1: read-only repo tool', () => {
  const realFetch = globalThis.fetch
  after(() => {
    globalThis.fetch = realFetch
  })

  it('refuses secret-shaped paths and traversal', () => {
    assert.equal(isDeniedPath('.env'), true)
    assert.equal(isDeniedPath('app/.env.production'), true)
    assert.equal(isDeniedPath('secrets/key.pem'), true)
    assert.equal(isDeniedPath('node_modules/x/index.js'), true)
    assert.equal(isDeniedPath('src/agents/runner.ts'), false)
    assert.throws(() => normalisePath('../../etc/passwd'))
  })

  it('lists a directory and hides denied files', async () => {
    globalThis.fetch = (async (url: any) => {
      assert.match(String(url), /contents\/src\/agents/)
      return new Response(
        JSON.stringify([
          { type: 'file', name: 'runner.ts', path: 'src/agents/runner.ts', size: 1200 },
          { type: 'file', name: '.env', path: 'src/agents/.env', size: 10 },
          { type: 'dir', name: 'nested', path: 'src/agents/nested' },
        ]),
        { status: 200 }
      )
    }) as any
    const out = await runRepoTool({ op: 'list', path: 'src/agents' }, { token: 't', repo: 'o/r', ref: 'main' })
    assert.match(out, /src\/agents\/runner\.ts/)
    assert.match(out, /nested/)
    assert.doesNotMatch(out, /\.env/)
  })

  it('reads a file with line numbers', async () => {
    const content = Buffer.from('line one\nline two\nline three', 'utf8').toString('base64')
    globalThis.fetch = (async () => new Response(JSON.stringify({ type: 'file', encoding: 'base64', content }), { status: 200 })) as any
    const out = await runRepoTool({ op: 'read', path: 'src/a.ts' }, { token: 't', repo: 'o/r', ref: 'main' })
    assert.match(out, /1 \| line one/)
    assert.match(out, /3 \| line three/)
  })

  it('refuses write operations', async () => {
    const out = await runRepoTool({ op: 'write', path: 'src/a.ts' }, { token: 't', repo: 'o/r', ref: 'main' })
    assert.match(out, /read-only/)
  })

  it('reports a missing token instead of calling GitHub', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as any
    const out = await runRepoTool({ op: 'list', path: 'src' }, { token: '', repo: 'o/r', ref: 'main' })
    assert.match(out, /GITHUB_TOKEN/)
    assert.equal(called, false)
  })

  it('gates the tool on access level', () => {
    assert.equal(hasRepoAccess('read'), true)
    assert.equal(hasRepoAccess('write'), true)
    assert.equal(hasRepoAccess('none'), false)
    assert.equal(hasRepoAccess(undefined), false)
  })
})
