import type { Context, Next } from 'hono'

export type UserRow = { id: string; wallet: string; role: string; created_at: string }
export type ApiKeyRow = {
  id: string; user_id: string; name: string; key_prefix: string;
  rpm: number; tpm: number; revoked_at: string | null; created_at: string;
  budget_usd_micros?: number | string | null;
  /** 'api' for the general gateway, 'antseed' for the marketplace relay. Defaults to 'api'. */
  scope?: string;
  period_start?: string | null;
  period_spent_usd_micros?: number | string;
}

export type AppEnv = {
  Variables: {
    user?: UserRow
    apiKey?: ApiKeyRow
    /** A policy middleware may hand the chat handler an already-sanitised request body. */
    chatBody?: Record<string, unknown>
    /** Which surface served the call (absent = the public gateway). Recorded for attribution. */
    chatSource?: 'antseed'
  }
}

export type Ctx = Context<AppEnv>
export type MW = (c: Ctx, next: Next) => Promise<Response | void>
