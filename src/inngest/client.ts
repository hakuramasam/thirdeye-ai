/**
 * Inngest client.
 *
 * Durable execution exists here for one measured reason: this platform runs on serverless
 * functions that stop the moment a response closes, and we have watched work vanish twice
 * (stream true-up, cron agent runs). Every step below survives a function dying mid-run and is
 * retried with the same idempotency key, so a retry converges instead of duplicating.
 */
import { Inngest } from 'inngest'

export const inngest = new Inngest({
  id: 'thirdeye-ai',
  name: 'Thirdeye AI',
  eventKey: process.env.INNGEST_EVENT_KEY,
})

/** True when the app is configured to serve Inngest. Absent keys are a clean 503, not a crash. */
export function inngestConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INNGEST_EVENT_KEY && env.INNGEST_SIGNING_KEY)
}

export type TeamRunEvent = { data: { agentId: string; input: string } }
export type ConvertEvent = { data: { limit?: number } }
