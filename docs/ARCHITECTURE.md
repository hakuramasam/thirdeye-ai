# HAKU Router — Architecture & Module Contract

OpenRouter-style AI gateway + autonomous agent platform. Working name, easy to rename.

- **Runtime**: Node 20+, TypeScript ESM (`"type": "module"`), Hono web framework.
- **DB**: Postgres. Dual driver via `src/db/index.ts`: `DATABASE_URL` set → hosted Postgres (`pg`), unset → embedded PGlite (demo mode).
- **Frontend**: Vite + React in `web/`, served at `/`, API under `/api/*` (same origin; Vite dev proxy forwards `/api` to :8787).
- **Money**: all amounts are **USD micros integers** (1,000,000 = $1.00).
- **Errors** (OpenAI-style, everywhere):
  ```json
  { "error": { "message": "...", "type": "auth|rate_limit|billing|invalid_request|upstream|not_found", "code": 401 } }
  ```

## Foundation (already implemented — DO NOT EDIT THESE FILES)
- `src/lib/env.ts` — `env` config, `newId()`, `sha256()`, `encryptSecret()/decryptSecret()`, `env.providerKeys` (map of `PROV_<NAME>_API_KEY` values, lowercase name → key)
- `src/db/index.ts` — `query(sql, params?) -> {rows, rowCount}`, `one(sql, params?) -> row|null`, `tx(fn(q) => T)`, `migrate()`, `dbMode()`
- `src/db/schema.sql` — full schema (users, api_keys, byok_keys, models_catalog, usage_events, ratelimit_counters, deposits, ledger, agents, agent_runs, auth_nonces). Read it.
- `src/lib/types.ts` — `AppEnv`, `UserRow`, `ApiKeyRow`, `Ctx`
- `src/lib/session.ts` — `createSessionToken(user)`, `readSession(c)`, `requireUser` middleware, `attachUser`, `setSessionCookie(c, token)`, `clearSessionCookie(c)`
- `src/lib/keys.ts` — `generateApiKeySecret()`, `createApiKey(userId, name, rpm, tpm) -> {secret, row}`, `apiKeyAuth` middleware (Bearer sk-haku-... → sets `c.get('user')` + `c.get('apiKey')`)
- `src/lib/ratelimit.ts` — `checkAndConsume(keyId, rpm, tpm, estTokens) -> {ok, reset_seconds, ...}`, `refundSlot(keyId, tokens)`
- `src/lib/pricing.ts` — `ModelRow`, `computeCostMicros(model, inTok, outTok, marginPct, byok) -> micros`
- `src/lib/billing.ts` — `getBalanceMicros(userId)`, `debitForUsage(userId, costMicros, ref) -> {ok, balance}` (ok:false = insufficient), `creditDeposit(userId, amountMicros, {chain, txHash, token}) -> {credited, balance}` (idempotent), `adjustCredit(userId, amountMicros, reason)`

## Route registration convention
Every route module exports: `export function register<Name>Routes(app: Hono<AppEnv>): void`.
All public routes are under `/api`. The v1 API (API-key auth) is `/api/v1/*`; dashboard
routes are session-auth (`requireUser`). The app object is created in `src/app.ts`
by the integrator; do not create servers.

Hono context: `c.get('user')`, `c.get('apiKey')` (typed via `AppEnv`).
Always call `await migrate()` before any DB use in tests (`migrate()` is idempotent).

## Modules / file ownership

### A. Gateway (`src/providers/`, `src/routes/v1.ts`) — owned by builder A
OpenAI-compatible inference API.

- `src/providers/index.ts` — MUST export:
  ```ts
  // Resolve a request to provider call. Chooses BYOK key when the user has one
  // for the model's provider (openai/groq/deepseek/... = "openai-compatible"
  // name match against byok_keys.provider), else platform key from
  // env.providerKeys (openai/anthropic by provider name; for
  // openai-compatible catalog rows the provider name is derived from the
  // base_url host: api.groq.com -> "groq", api.deepseek.com -> "deepseek").
  // Throws UpstreamError with .status and .json() when no key is available.
  export type ProviderCall = {
    model: ModelRow
    byok: boolean
    // Non-streaming call. params is an OpenAI chat completions request body
    // (model replaced with upstream_model upstream).
    call(params: Record<string, any>): Promise<{ content: string; prompt_tokens: number; completion_tokens: number; tool_calls?: any[] }>
    // Streaming call: returns the raw upstream Response (OpenAI SSE format),
    // already normalized so downstream is always OpenAI-style.
    stream(params: Record<string, any>): Promise<Response>
  }
  export async function resolveProvider(user: UserRow, model: ModelRow): Promise<ProviderCall>
  ```
- `src/providers/openai.ts` — call any OpenAI-based API (api.openai.com or `base_url`).
  Handle `stream:true` via `fetch` + SSE passthrough. Token usage from the final
  `usage` chunk; for non-stream from `response.usage`.
- `src/providers/anthropic.ts` — convert OpenAI format ↔ Anthropic Messages API
  (api.anthropic.com/v1/messages, `anthropic-version` header), incl. tools and
  streaming SSE conversion back to OpenAI chunk format.
- `src/providers/mock.ts` — provider `mock` (model `haku-mock`): deterministic canned
  responses locally (no network). Supports non-stream, stream (emit SSE chunks),
  tools (echoes a demo tool call when the input contains the word `weather`).
- `src/routes/v1.ts` — `registerV1Routes(app)`; auth: `apiKeyAuth` middleware.
  - `GET /api/v1/models` — `{ object: "list", data: [{ id, object: "model", owned_by, pricing: {prompt, completion} }] }` (pricing in USD per 1M as strings).
  - `POST /api/v1/chat/completions` — full OpenAI request/response compat incl. `stream`, `tools`, `max_tokens`, `temperature`, `messages`. Flow: validate model (from models_catalog, enabled) → rate limit (est tokens = chars of JSON messages /4; if !ok → 429 with `Retry-After` + rate limit headers) → resolveProvider → if NOT byok, require prepaid balance ≥ estimated minimum ($0.01) via billing `getBalanceMicros(user.id)`; else proceed → call/stream → record usage via `recordUsage` + charge via `debitForUsage` (only actual cost after response; BYOK cost is the 2% metering fee) → on upstream error, `refundSlot` and record failed usage status `5xx`.
  - Billing import: `import { getBalanceMicros, debitForUsage } from '../lib/billing.js'` (implemented by builder B, signatures below).
  - Usage import: `import { recordUsage } from '../lib/usage.js'` — THIS FILE IS OWNED BY A: `recordUsage({user_id, api_key_id, model, provider, byok, prompt_tokens, completion_tokens, cost_usd_micros, status, latency_ms})` inserts into usage_events. Also export `getUserUsageSeries(userId, days) -> [{day, requests, tokens, cost_usd_micros}]`.
  - Response headers on success: `X-Haku-Model`, `X-Haku-Byok`, `X-RateLimit-Remaining-RPM`, `X-Haku-Cost-Usd` (string).
- Tests `tests/gateway.test.ts`: migrate + seed user+key (`createApiKey`), call via `app.request()`:
  non-stream `haku-mock`, stream `haku-mock` (parse SSE), rate-limit 429 after exhausting rpm of a 2-rpm key, BYOK path (insert byok_keys row with `encryptSecret('test-key')` for provider "mock" and assert `X-Haku-Byok: true`), 401 bad key, unknown model 404/400.

### B. Payments / stats (`src/payments/`, `src/routes/credits.ts`, `src/routes/stats.ts`) — owned by builder B
- `src/payments/chains.ts` — supported chains config:
  ```ts
  export type ChainConfig = { id: string; name: string; chainId: number; rpc: string; tokens: { symbol: string; address: string; decimals: number }[] }
  export const CHAINS: ChainConfig[] = [
    { id: 'base', name: 'Base', chainId: 8453, rpc: 'https://mainnet.base.org', tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } ] },
    { id: 'robinhood', name: 'Robinhood Chain', chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com', tokens: [
      // USDG is Robinhood Chain's official stablecoin (USDC is not native there).
      // Use viem to verify decimals at build time and assert 6.
      { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 } ] },
  ]
  ```
- `src/payments/verify.ts` — `verifyDeposit({ chain, txHash, fromWallet })` using viem publicClient per chain:
  fetch transaction receipt, scan ERC-20 `Transfer` logs (topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`) where `to == env.platformReceiverAddress` and token address is in CHAINS tokens; require `from == fromWallet` (user's wallet) and tx status success. Return `{ ok: true, token, amount_usd_micros }` or throw/return error (`not_found | wrong_recipient | wrong_sender | unsupported_token | failed_tx | zero_amount`).
- `src/routes/credits.ts` — `registerCreditsRoutes(app)` (all `requireUser`):
  - `GET /api/credits` → `{ balance_usd_micros, ledger: [{amount_usd_micros, kind, ref, created_at}] }` (last 50)
  - `GET /api/credits/deposit-info` → `{ receiver_address, chains: CHAINS }` (receiver from `env.platformReceiverAddress`; if empty return it as empty string — UI shows a warning)
  - `POST /api/credits/deposit` `{ chain, tx_hash }` → verifyDeposit → `creditDeposit`. Errors: 400 with `type: 'billing'`, code from verify.
- `src/routes/stats.ts` — `registerStatsRoutes(app)`:
  - `GET /api/stats/me` (requireUser) → per-day series for the signed-in user over last 14 days: `[{day, requests, tokens, cost_usd_micros, deposits_usd_micros}]`
  - `GET /api/stats/public` (no auth) → platform-wide anonymized aggregates (this is the future tokenized-stocks feed): `{ totals: { requests, tokens, inflow_usd_micros, outflow_usd_micros, users }, series: [{day, requests, tokens, inflow_usd_micros, outflow_usd_micros}] }` — inflow = sum(ledger deposits), outflow = sum(negative ledger), over last 30 days. Include zero days.
- Tests `tests/payments.test.ts`: billing debit/credit lifecycle (balance math, idempotent deposit via same txHash, insufficient balance), deposit verify error paths using a fabricated `verifyDeposit` path where possible (unit test the log-parsing helper with a mock receipt — export `parseTransferLogs(receipt, chainConfig)` from verify.ts so it is unit-testable without a chain).

### C. Agents + MCP + x402 (`src/agents/`, `src/routes/agents.ts`) — owned by builder C
- `src/agents/mcp.ts` — MCP client via `@modelcontextprotocol/sdk` StreamableHTTP transport:
  `createMcpTools(servers: {name, url, headers?}[]) -> Promise<{ tools: any[] /* OpenAI tool defs */, call(toolName, args) -> Promise<string> /* result text */, close() }`.
  Tool names prefixed `mcp_<server>_<tool>`. Graceful per-server failure (log + skip).
- `src/agents/x402.ts` — `paidFetch(url, init?, { maxSpendUsdMicros })` using `x402-fetch`'s `wrapFetchWithPayment` with `privateKeyToAccount(env.agentWalletKey)` (viem) on Base (8453). If `env.agentWalletKey` empty or x402 disabled → plain fetch. Return `{ response, paid: boolean, spentUsdMicros }` (best effort; default spent 0). Verify the installed x402-fetch API (check `node_modules/x402-fetch` types/README) and adjust; if the package is unusable, implement a minimal manual 402 loop documented in code.
- `src/agents/runner.ts` — `runAgent(agentRow, input, user) -> Promise<{ runId, status, output, tool_calls, spend_usd_micros, error }>`:
  creates agent_runs row (status running), loop up to `agent.max_steps`: call chat completions **internally** through builder A's contract:
  `resolveProvider(user, modelRow)` (via a swappable injected `llm` dependency: `runAgent(agent, input, user, llm?)` — default resolves the provider, tests inject a fake) then `call({messages, tools, model})`; when the provider returns tool_calls → execute via MCP `call()` (or x402-marked URLs in args if agent.x402_enabled — arguments containing a URL field trigger `paidFetch` instead when the plain fetch returns 402) and continue the loop; else finish with content.
  Costs: compute with `computeCostMicros` (non-byok margin rate), sum into run spend, `debitForUsage(user.id, cost, 'agent:'+runId)` each step; stop early when balance insufficient or spend > agent.budget_usd_micros. Update agent_runs row; set agents.last_run_at. Model row: fetch from models_catalog by agent.model; if it resolves to `haku-mock`/provider mock, runner must still work end-to-end (mock provider supports a `weather` tool call).
- `src/routes/agents.ts` — `registerAgentsRoutes(app)` (requireUser except where noted):
  - CRUD: `GET /api/agents`, `POST /api/agents` `{name, system_prompt, model, mcp_servers?, x402_enabled?, budget_usd_micros?, max_steps?, cron?}`, `PATCH /api/agents/:id` (owner only), `DELETE /api/agents/:id`
  - `POST /api/agents/:id/run` `{input}` → run (synchronous, returns run result)
  - `GET /api/agents/:id/runs` → last 20 runs
  - `POST /api/cron/agents` (NO session; auth via `Authorization: Bearer $CRON_SECRET`) → run all active agents whose `cron` is due (minute-resolution check; track agents.last_run_at and a simple cron parser — support `*`, `*/n`, `m h dom mon dow` numeric fields) → `{ triggered: [...] }`
- Tests `tests/agents.test.ts`: build a tiny MCP server in-process using `@modelcontextprotocol/sdk` server + StreamableHTTP (a `weather` tool returning fixed JSON), seed user + agent (model `haku-mock`, mcp server url), run agent, assert output contains tool result and run row recorded with spend 0 (mock price 0). Also test cron-due logic (pure function `isCronDue(cron, now, lastRunAt)`).

### D. Dashboard + wallet auth (`web/`, `src/routes/auth.ts`) — owned by builder D
- `src/routes/auth.ts` — `registerAuthRoutes(app)`:
  - `GET /api/auth/nonce` → `{ nonce }` (random 32-hex, stored in auth_nonces, 10 min TTL — delete on use)
  - `POST /api/auth/verify` `{ message, signature }` — parse+verify SIWE (siwe package): signature valid, nonce match+delete, issued recently. Upsert user by wallet (lowercase), set session cookie via `createSessionToken`+`setSessionCookie`. → `{ user }`. If `env.platformReceiverAddress` empty → don't block.
  - `POST /api/auth/logout` → clear cookie
  - `GET /api/me` (attachUser) → `{ user | null, mode }` where mode = `dbMode()` ('postgres' = LIVE, 'pglite' = DEMO)
  - `GET /api/healthz` (no auth) → `{ ok: true, mode: dbMode(), time }`
- Frontend `web/` (Vite+React, single-page tabs, dark professional design, pure CSS — no UI libs):
  - **Wallet connect**: EIP-6963 multi-wallet discovery (`eip6963:announceProvider` event) + fallback `window.ethereum`. Show detected wallets (MetaMask, Rainbow, OKX, Bitget…) with names/icons via `eip6963` `icon` data URI. After connect → SIWE sign (build message with `createSiweMessage`-style helper or siwe package client-side) using the nonce endpoint → POST verify → session.
  - viem only (no wagmi/RainbowKit — they need a WalletConnect projectId; EIP-6963 covers injected wallets without it).
  - **Tabs** (only when signed in): Overview (balance, 14-day usage bar chart hand-rolled SVG, recent ledger), API Keys (list/create/revoke; show secret once; per-key RPM/TPM inputs), BYOK (add/remove provider key per provider name — free text provider name + key, stored encrypted), Credits (receiver address + copy button, chains/tokens table, submit `{chain, tx_hash}` form → balance), Agents (list/create/edit/delete + "Run now" showing output), Models (catalog with prices), Docs (curl quickstart).
  - Demo mode badge when `/api/me` mode is 'pglite' (banner: "Demo mode — data resets; connect Postgres via DATABASE_URL").
  - `web/src/main.tsx` etc. — full replacement of the stub. Must build (`npm run build:web`) cleanly.
- `src/routes/keys.ts` — `registerKeysRoutes(app)` (requireUser), dashboard API:
  - `GET /api/keys` — list keys (prefix, name, rpm, tpm, created, revoked) 
  - `POST /api/keys` `{name, rpm?, tpm?}` → `{secret, row}` (secret shown once)
  - `DELETE /api/keys/:id` (owner only; soft-revoke: set revoked_at)
  - `GET /api/keys/byok` — list BYOK providers `{providers: [{provider, created_at}]}`
  - `PUT /api/keys/byok` `{provider, api_key}` — upsert (encrypt via `encryptSecret`); `DELETE /api/keys/byok/:provider`
  - `GET /api/models` — enabled models_catalog rows for the UI (session auth)
- Tests: none required beyond a clean `tsc --noEmit` and `vite build`.

## Conventions
- Imports: relative with `.js` extension (`import { env } from '../lib/env.js'`) — works under tsx + bundler resolution.
- Never throw raw strings; use the error shape. Hono `app.onError` is registered by the integrator.
- `await migrate()` at the top of every test file (`import { migrate } from '../src/db/index.js'`); tests use `app.request()` against the real app.
- Timezone: store timestamptz; day series computed with `created_at::date` in SQL.
- All user input to SQL goes through `$n` params. Wallet addresses lowercased.
