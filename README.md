# Thirdeye AI

> OpenRouter-style AI gateway and wallet-native autonomous-agent platform.

One OpenAI-compatible API (`/api/v1/chat/completions`) routes catalogued models to configured provider integrations, with wallet-based signup, prepaid credits, per-key rate limiting, token metering, and agents that can use guarded MCP tools and x402 pay-per-call services.

## Feature map

| Area | What it does |
|---|---|
| **OpenAI-compatible API** | `POST /api/v1/chat/completions` (streaming and tool calls) and `GET /api/v1/models`. Both `/api/v1/*` endpoints require an `sk-thirdeye-...` bearer API key. |
| **Model catalog** | Enabled models live in `models_catalog` with upstream provider/model mapping and USD-micro rates per 1M tokens. OpenAI-compatible upstreams can be configured per model. |
| **Provider routing** | Resolves a model to its configured provider. A user's BYOK key takes precedence; otherwise the platform uses one configured key for that provider. Multi-key pooling, provider quotas and automatic failover are not implemented. |
| **BYOK** | Users bring their own provider keys (AES-256-GCM encrypted at rest). BYOK calls are metered at the configured reduced rate. |
| **Platform keys** | Brokered calls use configured provider keys (`PROV_<NAME>_API_KEY`) and debit prepaid credits at catalogue price plus margin (`PLATFORM_MARGIN_PCT`, default 10%). |
| **API keys** | `sk-thirdeye-...` secrets are SHA-256 hashed at rest, with per-key RPM/TPM limits, monthly budget caps and soft revoke. |
| **Wallet auth** | SIWE (Sign-In with Ethereum), EIP-6963 injected-wallet discovery and WalletConnect. No password account is required. |
| **Payments** | Deposit verification supports Base USDC, BNB Smart Chain USDT/USDC and Robinhood Chain USDG. Selected non-stable assets can be enabled with price/liquidity caps; THIRDEYE has a runtime policy-price registration path. Deposit confirmation-depth and reorg policy remain in progress. |
| **THIRDEYE token** | THIRDEYE launched on Base on 2026-11-12 with a fixed 1,000,000,000 supply. Deposit support is code/config driven (`PLATFORM_TOKEN_*`); this repository snapshot does not prove that production deposit configuration is active. |
| **Metering and ledger** | Requests are recorded in `usage_events` (tokens, cost, latency, status); credit movements are recorded in the ledger. Account and key balances are checked before usage. |
| **Public stats** | `GET /api/stats/public` exposes aggregate platform usage/inflow/outflow series. It is a data feed, not a tokenized-stocks product. |
| **Personal agents** | Per-user agents have prompts, model, budget, max steps, cron, run history, optional MCP servers and guarded x402 calls. Fine-grained schedules need an external pinger; Vercel's configured cron is daily. |
| **Agent identities** | External agents can register an identity/key, appear in the public directory and use the A2A card/JSON-RPC surface. |
| **Development team** | Twelve canonical role definitions, role skill packs, platform adapters, task contracts, pipeline definitions, audit events and addressable artifacts exist. Production telemetry does not yet prove reliable 12-role autonomous delivery; see the operational audit. |
| **Public site** | Platform, docs, roadmap, status, changelog, agent directory and read-only team activity pages are served by the API. |

## Scheduling autonomous agents

The Vercel cron in `vercel.json` calls `/api/cron/agents` daily at **09:00 UTC**. The application can evaluate finer per-agent cron expressions, but the Hobby schedule does not wake it every minute. For finer schedules, configure an external pinger to call `POST /api/cron/agents` with `Authorization: Bearer $CRON_SECRET`. The external pinger is an operational dependency, not an always-on scheduler supplied by the app.

## Local quickstart

```bash
npm install
cp .env.example .env         # optional; defaults run in demo mode
npm run dev                  # API on :8787
npm run dev:web              # dashboard on :5173 (proxies /api)
```

No `DATABASE_URL` → embedded Postgres (PGlite), file-backed at `.data/thirdeye`, seeded with demo data on boot. Any wallet can sign in and create local demo keys.

Try the API:

```bash
# Create a key in the dashboard (API Keys tab), then:
curl http://localhost:8787/api/v1/chat/completions \
  -H "Authorization: Bearer sk-thirdeye-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"thirdeye-mock","messages":[{"role":"user","content":"hello"}]}'
```

`thirdeye-mock` is a built-in provider for testing that needs no upstream provider key.

## OpenAI SDK compatibility

```python
from openai import OpenAI
client = OpenAI(base_url="https://<your-domain>/api/v1", api_key="sk-thirdeye-...")
resp = client.chat.completions.create(
    model="thirdeye-mock",
    messages=[{"role":"user","content":"hi"}],
)
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
- Configure `DATABASE_URL` (Neon), `SESSION_SECRET`, `MASTER_KEY`, `CRON_SECRET`, `PLATFORM_RECEIVER_ADDRESS`, and the provider keys you intend to broker.
- Optional THIRDEYE deposit registration uses `PLATFORM_TOKEN_ADDRESS`, `PLATFORM_TOKEN_SYMBOL`, `PLATFORM_TOKEN_DECIMALS`, `PLATFORM_TOKEN_USD_RATE`, `PLATFORM_TOKEN_BONUS_BPS` and the configured deposit cap. Do not enable a deposit asset until its receiver, valuation policy and limits are reviewed.
- `vercel.json` schedules `POST /api/cron/agents` daily at 09:00 UTC. External pingers are required for more frequent schedules.

## Security notes

- API keys are SHA-256 hashed; BYOK provider keys are AES-256-GCM encrypted with `MASTER_KEY`.
- Sessions are httpOnly JWT cookies (HS256, `SESSION_SECRET`).
- All SQL is parameterized. Wallet addresses are normalized.
- x402 payment credentials are server-side only and must be narrowly funded and capped.
- MCP server headers are not backed by a dedicated encrypted credential vault yet; avoid long-lived secrets in those headers.
- Agent repository writes are branch/PR-only, constrained by path/file/size/credential checks, and cannot merge. Money, key, schema, CI and agent-governance paths remain owner-managed.

## Layout

```
src/
  app.ts            Hono wiring (all routes)
  index.ts          Node server (serves API + built dashboard)
  api/index.ts      Vercel serverless entry
  db/               schema.sql, dual-driver client, demo seed
  lib/              env, keys, session, ratelimit, pricing, billing, usage
  providers/        OpenAI / Anthropic / OpenAI-compatible / mock integrations
  payments/         chain registry, deposit verification and pricing policy
  agents/           runner, MCP client, x402 client, cron, audit and artifacts
  routes/           v1 (OpenAI-compatible), auth, keys, credits, stats, agents
web/                Vite + React dashboard (SIWE / EIP-6963 / WalletConnect)
docs/               architecture, policies, audits and operating playbooks
tests/              node:test suites (PGlite for isolated database tests)
```

## Current roadmap

### Shipped in source

- WalletConnect/mobile wallet sign-in, SIWE and API-key management.
- OpenAI-compatible inference, streaming, tool calls, metering and cost headers.
- BYOK encryption, key-level credit/budget controls and account-level prepaid credits.
- Agent CRUD/manual run/run history, MCP configuration, x402 controls and agent identity/A2A endpoints.
- Public platform/docs/roadmap/status/changelog/directory/team pages.
- Correlation-aware audit events, addressable artifacts and a runtime pipeline planner.
- THIRDEYE Base launch (2026-11-12) and a configurable policy-priced deposit integration.

### In progress / not yet proven live

1. Deposit finality, confirmation-depth and reorg reconciliation.
2. Production release synchronization: the verified production deployment is behind current main; the current Vercel status check reports an account block.
3. Path-based product surfaces to avoid dependency on unavailable subdomain DNS verification (PR #120 remains open).
4. Real PostgreSQL Testcontainers CI coverage (PR #122 remains open; its integration job is being corrected to use the Node version required by Testcontainers).
5. Durable development-agent tasks and actual production pipeline/stage activation.

### Not implemented yet

- Multi-key provider pooling, per-provider quotas and automatic failover.
- Encrypted MCP credential vault.
- Durable task queue, leases, retries, resume and a customer/team task board.
- Reliable autonomous 12-role engineering delivery with independent QA and SENTINEL approval on the same SHA.
- Cross-customer admin console and model-pricing editor.
- Customer balance alerts, credit packs, invoices and receipts.
- Tokenized platform-metric assets.
- Secondary custom subdomains and a fully verified browser-based customer E2E suite.

## Current audit documents

- [Product truth audit](docs/PRODUCT_TRUTH_AUDIT_2026-11-28.md)
- [Agent-team operational audit](docs/AGENT_TEAM_OPERATIONAL_AUDIT_2026-11-28.md)
- [Agent pipeline status](docs/agent-pipeline.md)
- [Team scorecard](docs/team-scorecard.md)
