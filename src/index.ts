import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import app from './app.js'
import { env } from './lib/env.js'

const server = serve({
  fetch: app.fetch,
  port: env.port,
})

// Serve the built dashboard (web/dist) if present — single-origin local run.
try {
  const { statSync } = await import('node:fs')
  statSync('web/dist/index.html')
  app.use('*', serveStatic({ root: './web/dist' }))
} catch {
  // web/dist not built yet — API-only mode
}

console.log(`[thirdeye-ai] listening on http://localhost:${env.port}`)
export default server
