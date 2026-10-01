import type { Context, Next } from 'hono'

export type UserRow = { id: string; wallet: string; role: string; created_at: string }
export type ApiKeyRow = {
  id: string; user_id: string; name: string; key_prefix: string;
  rpm: number; tpm: number; revoked_at: string | null; created_at: string
}

export type AppEnv = {
  Variables: {
    user?: UserRow
    apiKey?: ApiKeyRow
  }
}

export type Ctx = Context<AppEnv>
export type MW = (c: Ctx, next: Next) => Promise<Response | void>
