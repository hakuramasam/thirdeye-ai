import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { AppEnv } from './lib/types.js'
import { migrate, dbMode, probe } from './db/index.js'
import { configProblems } from './lib/env.js'
import { configGuard, healthzBody, livezBody } from './lib/config-guard.js'
import { seedDemoData } from './db/seed-demo.js'

import { registerV1Routes } from './routes/v1.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerKeysRoutes } from './routes/keys.js'
import { registerCreditsRoutes } from './routes/credits.js'
import { registerRedeemRoutes } from './routes/redeem.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerInngestRoutes } from './routes/inngest.js'
import { registerTelegramRoutes } from './routes/telegram.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerAgentsRoutes, registerCronRoute } from './routes/agents.js'
import { registerPartnerRoutes } from './routes/partner.js'
import { registerDiscoveryRoutes } from './routes/discovery.js'
import { registerProfitRoutes } from './routes/profit.js'
import { registerFeedbackRoutes } from './routes/feedback.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerAgentApiRoutes } from './routes/agentApi.js'
import { registerPlaygroundRoutes } from './routes/playground.js'
import { registerParagraphRoutes } from './routes/paragraph.js'
import { registerArtifactsRoutes } from './routes/artifacts.js'
import { registerAntseedRoutes } from './routes/antseed.js'

const app = new Hono<AppEnv>()

app.use(logger())

// First, before anything touches the database: refuse the whole API on a deployment whose signing
// secrets or database configuration failed validation, naming the variable instead of dying as a
// bare 500 or, worse, serving an in-memory database that silently loses every write.
app.use('*', configGuard(configProblems))

// Ensure schema + (in demo mode) demo data exist before any DB-backed request.
let bootstrapped: Promise<void> | null = null
function bootstrap(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await migrate()
      if (dbMode() === 'pglite') await seedDemoData()
    })().catch((e) => {
      bootstrapped = null
      throw e
    })
  }
  return bootstrapped
}

/**
 * The two probes are registered before the database bootstrap on purpose.
 *
 * They sat behind the middleware below, which runs migrate() first, so a deployment whose
 * connection string was missing or malformed answered a generic 500 from migrate instead of naming
 * the problem. A readiness probe that cannot survive the failure it exists to report is not a probe.
 *
 * Liveness never touches the database. Readiness measures it, under the timeout in probe(), and
 * reports only a class of failure: the driver's own message names the host and database, and this
 * body is public.
 */
app.get('/api/livez', (c) => c.json(livezBody(dbMode())))
app.get('/api/healthz', async (c) => {
  // A refused deployment has no database to measure: its fallback would be an in-memory one, and
  // opening it just to report it healthy is the failure mode this refusal exists to prevent.
  const database = configProblems.length ? null : await probe(Number(process.env.HEALTH_DB_TIMEOUT_MS) || 2000)
  return c.json(healthzBody(configProblems, dbMode(), undefined, database))
})

app.use('/api/*', async (_c, next) => {
  await bootstrap()
  await next()
})

registerAuthRoutes(app)
registerKeysRoutes(app)
registerCreditsRoutes(app)
registerRedeemRoutes(app)
registerAdminRoutes(app)
registerParagraphRoutes(app)
registerArtifactsRoutes(app)
registerAntseedRoutes(app)
registerTelegramRoutes(app)
registerStatsRoutes(app)
registerPartnerRoutes(app)
registerDiscoveryRoutes(app)
registerProfitRoutes(app)
registerFeedbackRoutes(app)
registerPublicRoutes(app)
registerAgentApiRoutes(app)
registerPlaygroundRoutes(app)
registerAgentsRoutes(app)
registerCronRoute(app)
registerInngestRoutes(app)
registerV1Routes(app)

app.notFound((c) =>
  c.json({ error: { message: `Route not found: ${c.req.method} ${c.req.path}`, type: 'not_found', code: 404 } }, 404)
)

app.onError((err, c) => {
  console.error('[thirdeye] unhandled error:', err)
  return c.json({ error: { message: 'Internal server error', type: 'internal', code: 500 } }, 500)
})

export default app
