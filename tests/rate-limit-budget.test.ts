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
