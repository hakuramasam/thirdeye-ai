// Vercel serverless entry — Hono app behind the /api rewrite.
// Vercel's Node runtime ignores a default export that returns a Response,
// so we expose named HTTP methods (web-style) for every verb.
import app from '../src/app.js'
import { handle } from 'hono/vercel'

const handler = handle(app)

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const HEAD = handler
export const OPTIONS = handler
