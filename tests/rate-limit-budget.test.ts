process.env.PGLITE_DIR = 'memory://'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { callWithRateLimitRetry, retryDelayMs } = await import('../src/agents/retry.js')
const { errorCodeFrom } = await import('../src/agents/runner.js')

const GROQ_FREE_TIER = 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on tokens per minute (TPM): Limit 8000, Used 7980. Please try again in 12.5s.'

describe('surviving a provider rate limit instead of losing the day', () => {
  it('a single wait the provider asked for is still refused when the budget cannot cover it', async () => {
    const slept: number[] = []
    let calls = 0
    await assert.rejects(
      () =>
        callWithRateLimitRetry(
          async () => {
            calls++
            throw new Error(GROQ_FREE_TIER)
          },
          { totalWaitMs: 10_000, sleep: async (ms) => { slept.push(ms) } }
        ),
      /Rate limit/
    )
    assert.equal(calls, 1, 'a 12.25s wait does not fit a 10s budget, so it must not sleep at all')
    assert.deepEqual(slept, [])
  })

  it('a 50s budget outlasts a per-minute window, which a 25s budget cannot', async () => {
    // The shape that broke production: two refusals in a row, each asking for about 12.5s.
    const runWith = async (totalWaitMs: number) => {
      let calls = 0
      const slept: number[] = []
      try {
        await callWithRateLimitRetry(
          async () => {
            calls++
            if (calls <= 2) throw new Error(GROQ_FREE_TIER)
            return 'answered'
          },
          { attempts: 4, totalWaitMs, sleep: async (ms) => { slept.push(ms) } }
        )
        return { calls, slept, ok: true }
      } catch {
        return { calls, slept, ok: false }
      }
    }

    const old = await runWith(25_000)
    assert.equal(old.ok, false, 'the old 25s budget dies on the second refusal, as production did')
    assert.equal(old.calls, 2)

    const now = await runWith(50_000)
    assert.equal(now.ok, true, 'the new budget waits out both refusals and gets the answer')
    assert.equal(now.calls, 3)
    assert.deepEqual(now.slept, [12_750, 12_750])
  })

  it('never waits past the deadline that the function lifetime imposes', async () => {
    const slept: number[] = []
    let calls = 0
    await assert.rejects(
      () =>
        callWithRateLimitRetry(
          async () => {
            calls++
            throw new Error(GROQ_FREE_TIER)
          },
          {
            attempts: 6,
            totalWaitMs: 120_000,
            deadlineMs: Date.now() + 5_000,
            sleep: async (ms) => { slept.push(ms) },
          }
        ),
      /Rate limit/
    )
    assert.equal(calls, 1, 'a deadline 5s away cannot host a 12.25s wait')
    assert.deepEqual(slept, [])
  })

  it('a rate-limited run is not mistaken for a crash', () => {
    assert.equal(errorCodeFrom('rate_limited: Upstream OpenAI error: 429'), 'rate_limited')
    assert.equal(errorCodeFrom('Rate limit reached for model `openai/gpt-oss-120b`'), 'rate_limited')
    assert.equal(errorCodeFrom('429 Too Many Requests'), 'rate_limited')
    assert.equal(errorCodeFrom('uncaught: boom'), 'uncaught_exception', 'a real crash keeps its own code')
    assert.equal(errorCodeFrom('insufficient credits'), 'insufficient_credits')
  })

  it('the provider dial is parsed the way the runner hands it over', () => {
    assert.equal(retryDelayMs(GROQ_FREE_TIER), 12_750)
  })
})

describe('a run that hits the meter', () => {
  const setup = async () => {
    const { randomUUID } = await import('node:crypto')
    const { migrate, query, one } = await import('../src/db/index.js')
    const { runAgent } = await import('../src/agents/runner.js')
    await migrate()
    const wallet = `0x${randomUUID().replace(/-/g, '').padEnd(40, 'a').slice(0, 40)}`
    const user = { id: randomUUID(), wallet, role: 'user', created_at: new Date().toISOString() }
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [user.id, user.wallet, user.role])
    const agent = await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
       VALUES ($1, $2, 'HERMES', 'coordinate', 'stub-model', false, 'none', 100000, 2) RETURNING *`,
      [`tdt_rl_${randomUUID().slice(0, 6)}`, user.id]
    )
    return { runAgent, user, agent }
  }

  const refused = (delay: string) =>
    new Error(`Rate limit reached for model \`openai/gpt-oss-120b\` in organization \`org_x\` on tokens per minute (TPM). Please try again in ${delay}.`)

  it('waits out a refusal it can afford and finishes the work', async () => {
    const { runAgent, user, agent } = await setup()
    let calls = 0
    const llm = {
      call: async () => {
        calls++
        if (calls === 1) throw refused('0.01s')
        return { content: 'the day is done', prompt_tokens: 1, completion_tokens: 1 }
      },
    }
    const res = await runAgent(agent, 'do the day', user, { llm, retryWaitMs: 1_000 })
    assert.equal(res.status, 'success')
    assert.equal(calls, 2, 'the second attempt is the one that answers')
    assert.equal(res.rateLimited, undefined)
  })

  it('reports a refusal it cannot afford as rate_limited, not as a crash', async () => {
    const { runAgent, user, agent } = await setup()
    const { one } = await import('../src/db/index.js')
    let calls = 0
    const llm = {
      call: async () => {
        calls++
        throw refused('12.5s')
      },
    }
    const res = await runAgent(agent, 'do the day', user, { llm, retryWaitMs: 5_000 })
    assert.equal(res.status, 'error')
    assert.equal(res.rateLimited, true)
    assert.match(String(res.error), /^rate_limited:/)
    assert.equal(calls, 1, 'it must not sleep when the deadline cannot host the wait')

    const row = await one('SELECT status, error FROM agent_runs WHERE id = $1', [res.runId])
    assert.equal(row.status, 'error')
    assert.match(row.error, /^rate_limited:/, 'the stored row names the meter, so a human is not sent hunting a bug')
    assert.equal(errorCodeFrom(row.error), 'rate_limited')
  })
})

describe('the invocation ceiling, not just the wait', () => {
  it('a NaN budget refuses the wait instead of disabling both caps', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        callWithRateLimitRetry(
          async () => {
            calls++
            throw new Error(GROQ_FREE_TIER)
          },
          { totalWaitMs: Number.NaN, sleep: async () => {} }
        ),
      /Rate limit/
    )
    assert.equal(calls, 1, 'an unusable budget must not turn into an unlimited one')
  })

  it('a sleep that resolves past the deadline does not issue another call', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        callWithRateLimitRetry(
          async () => {
            calls++
            throw new Error('Rate limit reached. Please try again in 0.01s.')
          },
          {
            attempts: 5,
            totalWaitMs: 60_000,
            deadlineMs: Date.now() + 400,
            sleep: () => new Promise<void>((r) => setTimeout(r, 450)),
          }
        ),
      /Rate limit/
    )
    assert.equal(calls, 1, 'the wait overshot the deadline, so the retry must not happen')
  })

  it('a run with no time left records deadline_exceeded instead of calling the model', async () => {
    const { runAgent } = await import('../src/agents/runner.js')
    const { query } = await import('../src/db/index.js')
    const { randomUUID } = await import('node:crypto')
    const { migrate, one } = await import('../src/db/index.js')
    await migrate()
    const wallet = `0x${randomUUID().replace(/-/g, '').padEnd(40, 'b').slice(0, 40)}`
    const userId = randomUUID()
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, 'user')`, [userId, wallet])
    const agent = await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
       VALUES ($1, $2, 'HERMES', 'coordinate', 'stub-model', false, 'none', 100000, 2) RETURNING *`,
      [`tdt_dl_${randomUUID().slice(0, 6)}`, userId]
    )
    const user = { id: userId, wallet, role: 'user', created_at: new Date().toISOString() }
    let called = 0
    const res = await runAgent(agent, 'do the day', user as any, {
      llm: { call: async () => { called++; return { content: 'x', prompt_tokens: 1, completion_tokens: 1 } } },
      deadlineMs: Date.now() - 1,
    })
    assert.equal(called, 0, 'a call with no time left must not be started')
    assert.equal(res.status, 'error')
    assert.match(String(res.error), /^deadline_exceeded:/)
    assert.equal(errorCodeFrom(res.error), 'deadline_exceeded')
  })

  it('a refused run is audited with its own error code', async () => {
    const { runAgent } = await import('../src/agents/runner.js')
    const { migrate, one, query } = await import('../src/db/index.js')
    const { randomUUID } = await import('node:crypto')
    await migrate()
    const wallet = `0x${randomUUID().replace(/-/g, '').padEnd(40, 'c').slice(0, 40)}`
    const userId = randomUUID()
    await query(`INSERT INTO users (id, wallet, role) VALUES ($1, $2, 'user')`, [userId, wallet])
    const agent = await one(
      `INSERT INTO agents (id, user_id, name, system_prompt, model, can_delegate, repo_access, budget_usd_micros, max_steps)
       VALUES ($1, $2, 'HERMES', 'coordinate', 'stub-model', false, 'none', 100000, 2) RETURNING *`,
      [`tdt_audit_${randomUUID().slice(0, 6)}`, userId]
    )
    const user = { id: userId, wallet, role: 'user', created_at: new Date().toISOString() }
    const res = await runAgent(agent, 'do the day', user as any, {
      llm: { call: async () => { throw new Error(GROQ_FREE_TIER) } },
      retryWaitMs: 1_000,
    })
    assert.equal(res.rateLimited, true)
    const events = await query(
      `SELECT event_type, status, error_code FROM agent_audit_events WHERE run_id = $1 ORDER BY insert_seq`,
      [res.runId]
    )
    const codes = events.rows.map((r: any) => r.error_code).filter(Boolean)
    assert.ok(codes.includes('rate_limited'), `expected a rate_limited audit event, got ${JSON.stringify(codes)}`)
  })
})

describe('the deadline reaches the request itself', () => {
  it('a fractional or zero budget cannot throw before the request is sent', async () => {
    const { requestSignal, mapTimeoutError } = await import('../src/providers/index.js')
    assert.ok(requestSignal(1.5) instanceof AbortSignal, 'a fractional value must be floored, not rejected')
    assert.ok(requestSignal(1) instanceof AbortSignal)
    assert.equal(requestSignal(0), undefined, 'no budget means no signal')
    assert.equal(requestSignal(undefined), undefined)
    assert.equal(requestSignal(Number.NaN), undefined)

    const err: any = new Error('aborted')
    err.name = 'TimeoutError'
    assert.throws(() => mapTimeoutError(err, 250), (e: any) => e.status === 504 && /timed out after 250ms/.test(e.message))
  })

  it('the ceiling setting is clamped to a range where it still means something', async () => {
    const { msSettingBetween } = await import('../src/lib/env.js')
    assert.equal(msSettingBetween('0', 60_000, 20_000, 60_000), 60_000, '0 would fail every run before its first call')
    assert.equal(msSettingBetween('5000', 60_000, 20_000, 60_000), 60_000, 'the reserve alone is not a ceiling')
    assert.equal(msSettingBetween('90000', 60_000, 20_000, 60_000), 60_000, 'past the platform kill is not a ceiling')
    assert.equal(msSettingBetween('45000', 60_000, 20_000, 60_000), 45_000)
    assert.equal(msSettingBetween('abc', 60_000, 20_000, 60_000), 60_000)
  })

  it('a slow provider is aborted and mapped, including a body read after the headers', async () => {
    const http = await import('node:http')
    const { callOpenAIChat } = await import('../src/providers/openai.js')
    // Headers arrive, then the body stalls past the deadline: the shape that used to escape the
    // timeout catch and be recorded as an uncaught crash.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"choices":')
      setTimeout(() => { try { res.end('[]}') } catch { /* already aborted */ } }, 400)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as any).port
    try {
      await assert.rejects(
        () => callOpenAIChat({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', params: { messages: [] }, timeoutMs: 60 }),
        (e: any) => e.status === 504 && /timed out after 60ms/.test(e.message)
      )
    } finally {
      server.close()
    }
  })
})
