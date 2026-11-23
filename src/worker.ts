import { Hono } from 'hono'

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> }
  ENVIRONMENT?: string
  STAGING_DATABASE_ENABLED?: string
  LIVE_PAYMENTS_ENABLED?: string
  AGENT_EXECUTION_ENABLED?: string
}

const app = new Hono<{ Bindings: Env }>()

const disabled = {
  staging: true,
  livePayments: false,
  productionAgentExecution: false,
  databaseWrites: false,
}

app.get('/api/livez', (c) =>
  c.json({ ok: true, service: 'thirdeye-ai', runtime: 'cloudflare-workers', ...disabled }),
)

app.get('/api/healthz', (c) => {
  const databaseConfigured = c.env.STAGING_DATABASE_ENABLED === 'true'
  return c.json(
    {
      ok: false,
      service: 'thirdeye-ai',
      runtime: 'cloudflare-workers',
      database: databaseConfigured ? 'configured-but-not-integrated' : 'not-configured',
      reason: 'Cloudflare staging API remains fail-closed until an isolated staging database and Hyperdrive binding are provisioned.',
      ...disabled,
    },
    503,
  )
})

// The API is deliberately fail-closed. Do not forward application routes to the
// Node/Vercel entry point until the database, auth, payments and agent adapters
// have passed their Workers-specific integration tests.
app.all('/api/*', (c) =>
  c.json(
    {
      error: 'staging_api_not_migrated',
      message: 'ThirdEye AI API routes are not enabled on this Cloudflare staging deployment yet.',
      ...disabled,
    },
    503,
  ),
)

app.notFound(async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw)
  return c.text('ThirdEye AI staging frontend assets are not built.', 503)
})

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    return app.fetch(request, env, ctx as never)
  },
}
