import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryDelayMs, isRateLimitError, callWithRateLimitRetry } from '../src/agents/retry.js'

test('the provider-requested delay is parsed and capped', () => {
  assert.equal(retryDelayMs('Rate limit reached. Please try again in 7.5s'), 7750)
  assert.equal(retryDelayMs('429 too many requests, retry-after: 2'), 2250)
  assert.equal(retryDelayMs('no delay mentioned'), null)
  assert.equal(retryDelayMs('try again in 999s'), 60_000, 'a long ask is capped, not honoured blindly')
})

test('only meter failures are treated as retryable', () => {
  assert.equal(isRateLimitError('429 Too Many Requests'), true)
  assert.equal(isRateLimitError('tokens per minute exceeded'), true)
  assert.equal(isRateLimitError('401 invalid api key'), false)
  assert.equal(isRateLimitError('402 add usage credits'), false)
})

test('a rate limit is waited out and the call then succeeds', async () => {
  let calls = 0
  const slept: number[] = []
  const out = await callWithRateLimitRetry(
    async () => {
      calls++
      if (calls === 1) throw new Error('429 try again in 1s')
      return 'ok'
    },
    { sleep: async (ms) => { slept.push(ms) } },
  )
  assert.equal(out, 'ok')
  assert.equal(calls, 2)
  assert.deepEqual(slept, [1250])
})

test('a non-rate-limit error is thrown on the first attempt', async () => {
  let calls = 0
  await assert.rejects(
    () => callWithRateLimitRetry(async () => { calls++; throw new Error('401 invalid api key') }, { sleep: async () => {} }),
    /401/,
  )
  assert.equal(calls, 1)
})

test('a wait longer than the remaining budget is refused instead of sleeping past it', async () => {
  let calls = 0
  await assert.rejects(
    () => callWithRateLimitRetry(
      async () => { calls++; throw new Error('429 try again in 30s') },
      { totalWaitMs: 5_000, sleep: async () => {} },
    ),
    /429/,
  )
  assert.equal(calls, 1, 'no second call when the wait cannot fit the budget')
})

test('attempts are capped', async () => {
  let calls = 0
  await assert.rejects(
    () => callWithRateLimitRetry(
      async () => { calls++; throw new Error('429 try again in 1s') },
      { attempts: 3, totalWaitMs: 60_000, sleep: async () => {} },
    ),
    /429/,
  )
  assert.equal(calls, 3)
})

test('an exhausted deadline refuses a further call even when the budget allows it', async () => {
  let calls = 0
  await assert.rejects(
    () => callWithRateLimitRetry(
      async () => { calls++; throw new Error('429 try again in 1s') },
      { attempts: 5, totalWaitMs: 60_000, deadlineMs: Date.now() - 1, sleep: async () => {} },
    ),
    /429/,
  )
  assert.equal(calls, 1)
})
