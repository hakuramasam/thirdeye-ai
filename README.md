# Thirdeye AI

> OpenRouter-style AI gateway + autonomous agent platform. Working name (Thirdeye AI) — easy to rename.

One OpenAI-compatible API (`/api/v1/chat/completions`) that routes to any provider,
with wallet-based signup, prepaid USDC/USDG credits, per-key rate limiting,
full token metering, and autonomous agents that can use MCP tools and x402
pay-per-call services.

## Feature map

| Area | What it does |
| --- | --- |
| **OpenAI-compatible API** | `POST /api/v1/chat/completions` (incl. `stream: true`, tools), `GET /api/v1/models`. Drop-in for OpenAI SDKs: just change the base URL and key. |
| **Model catalog** | Seeded in `models_catalog` (OpenAI, Anthropic, Groq, DeepSeek, mock). Prices per 1M tokens in USD micros. Add any OpenAI-based provider by inserting a row. |
| **BYOK** | Users bring their own provider keys (stored AES-256-GCM encrypted). BYOK calls are metered but not charged full price (2% metering rate). |
| **Platform keys** | Brokered calls use the platform's provider keys (`PROV_<NAME>_API_KEY`) and are charged from prepaid credits at catalog price + margin (`PLATFORM_MARGIN_PCT`, default 10%). |
| **API keys** | `sk-thirdeye-...` secrets, SHA-256 hashed at rest, per-key RPM/TPM limits (fixed window), soft-revoke. |
| **Wallet auth** | SIWE (Sign-In with Ethereum) via EIP-6963 multi-wallet discovery: MetaMask, Rainbow, OKX, Bitget — any injected wallet. No passwords, no email. |
| **Payments** | On-chain stablecoin deposits, verified from chain RPCs: USDC on Base (8453) and USDG on Robinhood Chain (4663 — USDG is the chain's official stablecoin; config is token-agnostic so USDC can be added there the day it exists). User sends USDC/USDG to the platform receiver wallet, submits the tx hash, the platform verifies the Transfer log and credits the account. Idempotent. |
| **Metering & ledger** | Every request recorded in `usage_events` (tokens, cost, latency, status); every credit movement in the signed `ledger`. Prepaid balance enforced per request. |
| **Stats feed** | `GET /api/stats/public` — platform-wide inflow/outflow + usage series. This is the data plumbing for the planned tokenized-stocks product. |
| **Autonomous agents** | Per-user agents with system prompt, model, budget, max steps, cron schedule. Tools from MCP servers (streamable HTTP), plus an `http_fetch` tool that speaks x402 (HTTP 402 pay-per-call, USDC on Base) when enabled. Runs recorded with spend. |
| **Platform token (roadmap)** | The billing layer is behind `src/lib/billing.ts`; adding "pay with the platform token" is a new deposit-verification path + adapter, no API changes. |

## Local quickstart

```bash
npm install
cp .env.example .env         # optional; defaults run in demo mode
npm run dev                  # API on :8787
npm run dev:web              # dashboard on :5173 (proxies /api)
```

No `DATABASE_URL` → embedded Postgres (PGlite), file-backed at `.data/thirdeye`, seeded
with demo data on boot. Any wallet can sign in and create real keys.

Try the API:

```bash
# create a key in the dashboard (API Keys tab), then:
curl http://localhost:8787/api/v1/chat/completions \
  -H "Authorization: Bearer sk-thirdeye-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

`thirdeye-mock` is a built-in provider for testing that needs no upstream keys.

## OpenAI SDK compatibility

```python
from openai import OpenAI
client = OpenAI(base_url="https://<your-domain>/api/v1", api_key="sk-thirdeye-...")
resp = client.chat.completions.create(model="gpt-4o-mini",
                                      messages=[{"role":"user","content":"hi"}])
```

## Database

Two drivers, same SQL (`src/db/index.ts`):

- `DATABASE_URL` set → hosted Postgres (Neon / Supabase / RDS). **Use this in production.**
- unset → embedded PGlite (demo mode; on serverless it is in-memory and resets on cold start — the UI shows a DEMO banner).

Schema is applied automatically at boot (`src/db/schema.sql`).

## Deploying to Vercel

```bash
vercel --prod
```

- Static dashboard → `web/dist` (built by `npm run build:web`), API → `api/index.ts` serverless function behind `/api/*` rewrites.
- Set env vars (Vercel → Settings → Environment Variables): `DATABASE_URL` (Neon free tier works), `SESSION_SECRET`, `MASTER_KEY`, `CRON_SECRET`, `PLATFORM_RECEIVER_ADDRESS`, and any `PROV_*_API_KEY` you want to broker.
- `vercel.json` registers a cron hitting `POST /api/cron/agents` hourly (Vercel sends `Authorization: Bearer $CRON_SECRET`). On the Hobby plan Vercel limits crons to once a day; use any external pinger (e.g. cron-job.org) for tighter schedules.

## Security notes

- API keys stored as SHA-256 hashes; BYOK keys AES-256-GCM encrypted with `MASTER_KEY`.
- Sessions are httpOnly JWT cookies (HS256, `SESSION_SECRET`).
- All SQL is parameterized. Wallet addresses lowercased everywhere.
- x402 agent wallet (`AGENT_WALLET_PRIVATE_KEY`) is only used server-side to pay per-call invoices on Base; keep it funded with a small amount of USDC and nothing else.

## Layout

```
src/
  app.ts            Hono wiring (all routes)
  index.ts          Node server (serves API + built dashboard)
  api/index.ts      Vercel serverless entry
  db/               schema.sql, dual-driver client, demo seed
  lib/              env, keys, session, ratelimit, pricing, billing, usage
  providers/        openai / anthropic / openai-compatible / mock + router
  payments/         chains config, deposit verification (viem)
  agents/           runner, MCP client, x402 client, cron parser
  routes/           v1 (OpenAI-compatible), auth, keys, credits, stats, agents
web/                Vite + React dashboard (SIWE / EIP-6963)
docs/ARCHITECTURE.md  module contract (the source of truth)
tests/              per-module tests (node:test, PGlite in-memory)
```

## Roadmap (explicitly not built yet)

1. **Platform token**: launch the token, add a deposit-verification path for it in `src/payments/`, add "pay in token" toggle per user. The billing/ledger layer already supports it.
2. **Tokenized stocks of platform metrics**: `GET /api/stats/public` is the feed (inflow/outflow/usage series); the tokenization layer consumes it.
3. WalletConnect/mobile-wallet support (needs a WalletConnect projectId).
4. Provider key pooling + per-provider quotas.
5. Admin panel (usage across users, manual credits, model pricing editor).
