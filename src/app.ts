import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { AppEnv } from './lib/types.js'
import { migrate, dbMode } from './db/index.js'
import { seedDemoData } from './db/seed-demo.js'

import { registerV1Routes } from './routes/v1.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerKeysRoutes } from './routes/keys.js'
import { registerCreditsRoutes } from './routes/credits.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerAgentsRoutes, registerCronRoute } from './routes/agents.js'

const app = new Hono<AppEnv>()

app.use(logger())

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

app.use('/api/*', async (_c, next) => {
  await bootstrap()
  await next()
})

app.get('/api/healthz', (c) => c.json({ ok: true, mode: dbMode(), time: new Date().toISOString() }))

registerAuthRoutes(app)
registerKeysRoutes(app)
registerCreditsRoutes(app)
registerAdminRoutes(app)
registerStatsRoutes(app)
registerAgentsRoutes(app)
registerCronRoute(app)
registerV1Routes(app)

app.notFound((c) =>
  c.json({ error: { message: `Route not found: ${c.req.method} ${c.req.path}`, type: 'not_found', code: 404 } }, 404)
)

app.onError((err, c) => {
  console.error('[thirdeye] unhandled error:', err)
  return c.json({ error: { message: 'Internal server error', type: 'internal', code: 500 } }, 500)
})

export default app
