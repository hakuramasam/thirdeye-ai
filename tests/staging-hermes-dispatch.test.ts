process.env.PGLITE_DIR = 'memory://'

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { AppEnv } from '../src/lib/types.js'
import { migrate, query, one } from '../src/db/index.js'
import { registerStagingHermesDispatchRoute, reviewVerdict } from '../src/routes/stagingHermesDispatch.js'
import { reserveSharedBudget, settleSharedBudget } from '../src/agents/shared-budget.js'

const TARGET_SHA = 'dd956e60524020d1e8218bd1652d1cab356d2414'
const CAP = 67_000

describe('staging HERMES dispatch guardrails', () => {
  before(async () => {
    await migrate()
    await query(`INSERT INTO users (id, wallet, role) VALUES ('staging-owner', '0x5555555555555555555555555555555555555555', 'admin') ON CONFLICT DO NOTHING`)
  })

  it('requires the staging credential and never accepts CRON_SECRET as a substitute', async () => {
    process.env.VERCEL = '1'
    process.env.VERCEL_ENV = 'preview'
    process.env.VERCEL_GIT_COMMIT_SHA = 'feature-preview-sha'
    process.env.STAGING_DISPATCH_SECRET = 'test-staging-secret'
    process.env.CRON_SECRET = 'test-cron-secret'
    const app = new Hono<AppEnv>()
    registerStagingHermesDispatchRoute(app)

    const missing = await app.request('/api/ops/staging/hermes-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 'dispatch-1', target_sha: TARGET_SHA }),
    })
    assert.equal(missing.status, 401)

    const cron = await app.request('/api/ops/staging/hermes-review', {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 'dispatch-1', target_sha: TARGET_SHA }),
    })
    assert.equal(cron.status, 401)
  })

  it('refuses production, development, and missing deployment identity before database dispatch', async () => {
    process.env.STAGING_DISPATCH_SECRET = 'test-staging-secret'
    process.env.STAGING_DISPATCH_ENABLED = 'true'
    process.env.STAGING_DISPATCH_DEPLOYMENT_SHA = 'feature-preview-sha'
    const app = new Hono<AppEnv>()
    registerStagingHermesDispatchRoute(app)
    for (const envName of ['production', 'development', '']) {
      process.env.VERCEL_ENV = envName
      const response = await app.request('/api/ops/staging/hermes-review', {
        method: 'POST',
        headers: { authorization: 'Bearer test-staging-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ dispatch_id: 'dispatch-env-' + (envName || 'missing'), target_sha: TARGET_SHA }),
      })
      assert.notEqual(response.status, 200)
    }
    process.env.VERCEL_ENV = 'preview'
    process.env.VERCEL_GIT_COMMIT_SHA = ''
    const missingSha = await app.request('/api/ops/staging/hermes-review', {
      method: 'POST',
      headers: { authorization: 'Bearer test-staging-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 'dispatch-no-deploy-sha', target_sha: TARGET_SHA }),
    })
    assert.notEqual(missingSha.status, 200)
  })

  it('pins the review SHA and rejects unknown request keys', async () => {
    process.env.VERCEL_ENV = 'preview'
    process.env.VERCEL_GIT_COMMIT_SHA = 'feature-preview-sha'
    process.env.STAGING_DISPATCH_DEPLOYMENT_SHA = 'feature-preview-sha'
    process.env.STAGING_DISPATCH_SECRET = 'test-staging-secret'
    process.env.STAGING_DISPATCH_ENABLED = 'false'
    const app = new Hono<AppEnv>()
    registerStagingHermesDispatchRoute(app)

    const wrongSha = await app.request('/api/ops/staging/hermes-review', {
      method: 'POST',
      headers: { authorization: 'Bearer test-staging-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 'dispatch-wrong-sha', target_sha: 'main' }),
    })
    assert.equal(wrongSha.status, 400)

    const extraKey = await app.request('/api/ops/staging/hermes-review', {
      method: 'POST',
      headers: { authorization: 'Bearer test-staging-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 'dispatch-extra-key', target_sha: TARGET_SHA, agent_id: 'tdt_architect' }),
    })
    assert.equal(extraKey.status, 400)

    const disabled = await app.request('/api/ops/staging/hermes-review', {
      method: 'POST',
      headers: { authorization: 'Bearer test-staging-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 'dispatch-disabled', target_sha: TARGET_SHA }),
    })
    assert.equal(disabled.status, 503)
  })

  it('accepts only explicit, unambiguous reviewer verdict lines', () => {
    assert.equal(reviewVerdict('VERDICT: APPROVE\\nAll checks passed.'), 'APPROVE')
    assert.equal(reviewVerdict('VERDICT: REQUEST_CHANGES\\nIssue found.'), 'REQUEST_CHANGES')
    assert.equal(reviewVerdict('VERDICT: BLOCKED'), 'BLOCKED')
    assert.equal(reviewVerdict('The review looks good.'), null)
    assert.equal(reviewVerdict('VERDICT: APPROVED'), null)
    assert.equal(reviewVerdict('Preamble\\nVERDICT: APPROVE'), null)
  })

  it('reserves a single aggregate cap atomically across concurrent reviewers', async () => {
    await query(`INSERT INTO staging_agent_dispatches (id, target_sha, status, budget_cap_usd_micros, correlation_id)
      VALUES ('budget-concurrency', $1, 'running', $2, 'corr-budget-concurrency') ON CONFLICT (id) DO NOTHING`, [TARGET_SHA, CAP])

    const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reserveSharedBudget('budget-concurrency', 'reservation-' + i, 10_000)
    ))
    const accepted = attempts.filter((x: any) => x.ok)
    assert.ok(accepted.length <= 6, 'reservations must not exceed the shared 67,000-micro cap')
    const ledger = await one(`SELECT reserved_usd_micros, spent_usd_micros, budget_cap_usd_micros
      FROM staging_agent_dispatches WHERE id = 'budget-concurrency'`)
    assert.ok(Number(ledger.reserved_usd_micros) + Number(ledger.spent_usd_micros) <= CAP)
  })

  it('settles actual spend and releases unused reservation; refuses over-cap settlement', async () => {
    await query(`INSERT INTO staging_agent_dispatches (id, target_sha, status, budget_cap_usd_micros, correlation_id)
      VALUES ('budget-settlement', $1, 'running', $2, 'corr-budget-settlement') ON CONFLICT (id) DO NOTHING`, [TARGET_SHA, CAP])
    const reserved = await reserveSharedBudget('budget-settlement', 'reservation-settle', 20_000)
    assert.equal(reserved.ok, true)
    const settled = await settleSharedBudget('budget-settlement', 'reservation-settle', 12_000)
    assert.equal(settled.ok, true)
    const ledger = await one(`SELECT reserved_usd_micros, spent_usd_micros
      FROM staging_agent_dispatches WHERE id = 'budget-settlement'`)
    assert.equal(Number(ledger.reserved_usd_micros), 0)
    assert.equal(Number(ledger.spent_usd_micros), 12_000)
    const over = await settleSharedBudget('budget-settlement', 'reservation-settle', 20_001)
    assert.equal(over.ok, false)
  })
})
