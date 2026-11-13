/** Vercel/Inngest serve endpoint. Inngest calls this to discover and run the functions. */
import type { Hono } from 'hono'
import { serve } from 'inngest/hono'
import { inngest, inngestConfigured } from '../inngest/client.js'
import { functions } from '../inngest/functions.js'

export function registerInngestRoutes(app: Hono<any>): void {
  const handler = serve({ client: inngest, functions })
  app.on(['GET', 'POST', 'PUT'], '/api/inngest', async (c) => {
    if (!inngestConfigured()) {
      // Explicit and diagnosable instead of a broken endpoint the dashboard reports as failed.
      return c.json(
        {
          error: {
            message: 'Inngest is not configured: INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY are unset.',
            type: 'integration',
            code: 503,
          },
        },
        503
      )
    }
    return handler(c)
  })
}
