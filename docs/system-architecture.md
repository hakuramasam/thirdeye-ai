# Thirdeye AI — Core System Architecture

*(Working draft v1, 2026-10-01. Companion to `ARCHITECTURE.md`, which is the module-level build contract.)*

## 1. What Thirdeye AI is

A self-hosted, OpenRouter-style **AI gateway + agent platform**:

- one **OpenAI-compatible API** (`/api/v1/chat/completions`, `/api/v1/models`) that routes to any provider
- **wallet-native accounts** (SIWE; MetaMask, Rainbow, OKX, Bitget via EIP-6963)
- **prepaid stablecoin credits** (USDC on Base, USDG on Robinhood Chain)
- **BYOK** (users' own provider keys) alongside platform-brokered inference
- **autonomous agents** with MCP tool calling and x402 pay-per-call services
- a **stats feed** (inflows/outflows/usage) that will later back the tokenized-stocks product and the platform token

## 2. System layers

```
┌─────────────────────────────────────────────────────────────────┐
│ Dashboard (web/, Vite+React, SIWE + EIP-6963)                    │
│   keys · BYOK · credits · agents · models · docs                 │
└───────────────┬─────────────────────────────────────────────────┘
                │ /api/*  (session cookie = JWT)
┌───────────────▼─────────────────────────────────────────────────┐
│ API Gateway (Hono — src/app.ts)                                  │
│  ├ /api/v1/*        OpenAI-compatible, Bearer sk-thirdeye-*      │
│  │                  auth → rate limit → route → meter → charge   │
│  ├ /api/auth/*      SIWE nonce/verify, session                   │
│  ├ /api/keys/*      API key CRUD + encrypted BYOK vault          │
│  ├ /api/credits/*   deposit-info, verify+credit, balances        │
│  ├ /api/agents/*    agent CRUD + run + cron trigger              │
│  └ /api/stats/*     per-user series + public platform feed       │
├─────────────────────────────────────────────────────────────────┤
│ Provider layer (src/providers/)                                 │
│   openai · anthropic (format-converted) · openai-compatible      │
│   (groq/deepseek/… via base_url) · mock                          │
│   key resolution: BYOK first, then platform PROV_*_API_KEY       │
├─────────────────────────────────────────────────────────────────┤
│ Billing core (src/lib/billing.ts, ledger table)                 │
│   prepaid balance · atomic debits · idempotent deposits          │
│   cost = tokens × catalog price × (1 + margin) [or 2% for BYOK]  │
├─────────────────────────────────────────────────────────────────┤
│ Payments (src/payments/)                                        │
│   chain configs (Base 8453 / Robinhood 4663) + viem receipt check │
├─────────────────────────────────────────────────────────────────┤
│ Agents (src/agents/)                                            │
│   runner loop · MCP client (streamable HTTP) · x402 paidFetch   │
│   cron parser · per-run budgets from the ledger                  │
├─────────────────────────────────────────────────────────────────┤
│ DB (Postgres: Neon/etc or embedded PGlite for demo)              │
│   users · api_keys · byok_keys · models_catalog · usage_events   │
│   ratelimit_counters · deposits · ledger · agents · agent_runs  │
└─────────────────────────────────────────────────────────────────┘
```

Deployment: Vercel (static dashboard + serverless API at `/api/*`, hourly cron for
due agents). Any Node host works too (`npm start` serves both).

## 3. Request lifecycle (brokered call, `POST /api/v1/chat/completions`)

1. **Auth** — `Authorization: Bearer sk-thirdeye-…` → SHA-256 hash lookup in `api_keys`; revoked/missing → 401.
2. **Rate limit** — fixed-window RPM/TPM per key (`ratelimit_counters`); exceeded → 429 + `Retry-After`.
3. **Model resolution** — `models_catalog` row for the requested model; disabled/unknown → 404/400.
4. **Key routing** — BYOK key for the provider if the user has one (→ charged 2% metering only), else platform key; none available → 402 with actionable message.
5. **Balance gate** — brokered calls require ≥ $0.01 prepaid credit.
6. **Upstream call** — OpenAI-format request translated per provider (Anthropic converted in both directions); `stream: true` passes SSE through unchanged.
7. **Metering & charge** — actual token usage recorded (`usage_events`), cost computed with margin, atomically debited from the ledger.
8. **Response** — OpenAI-compatible body + `X-Thirdeye-*` headers (model, byok, cost, rate-limit remainder).

## 4. USDC payment flow on Base (chain 8453)

```
User wallet (MetaMask/Rainbow/OKX/Bitget)          Thirdeye AI
        │                                              │
        │ 1. SIWE sign-in (nonce → personal_sign) ────►│  session JWT cookie
        │                                              │
        │ 2. GET /api/credits/deposit-info ◄───────────│  receiver: treasury wallet
        │     (treasury: 0x38a4…e940)                  │  token: USDC 0x8335…2913 (6dp)
        │     (USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
        │                                              │
        │ 3. user sends USDC on Base ──(Base network)──►│  (plain ERC-20 transfer,
        │    from: user wallet                          │   to: treasury, any amount)
        │    to: treasury 0x38a4…e940                   │
        │                                              │
        │ 4. POST /api/credits/deposit                 │
        │    {chain:"base", tx_hash:"0x…"} ────────────►│  5. verification via Base RPC:
        │                                              │     eth_getTransactionReceipt
        │                                              │     ├ tx.status == success
        │                                              │     ├ Transfer log: token==USDC
        │                                              │     ├ to == treasury
        │                                              │     └ from == user's wallet
        │                                              │  6. amount = value / 10^6 → USD micros
        │                                              │  7. creditDeposit(): idempotent upsert
        │     {credited, balance} ◄────────────────────│     (deposits unique by chain+tx+token;
        │                                              │      ledger += amount, kind='deposit')
        │                                              │
        │ 8. subsequent API requests ─────────────────►│  prepaid balance debited per request
```

Properties:
- **Trust model**: no custody contract or intermediary — a direct transfer to the
  platform treasury; the server never needs to move funds, only *verify* receipts.
- **Idempotent**: the same tx hash can never be credited twice (DB unique constraint).
- **Sender-bound**: deposits must come from the wallet registered to the account
  (multi-wallet linking is a tracked enhancement).
- **Robinhood Chain parity**: identical flow with USDG
  (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, chain 4663) — USDG is that chain's
  official stablecoin; USDC is not natively issued there. The chain/token table is
  config-driven, so adding USDC on Robinhood (or any chain/token, including the
  future platform token) is one row in `CHAINS`.
- **Platform token (planned)**: "pay in token" = a new deposit-verification row (token
  address + price conversion at credit time) plus a per-user billing currency toggle.
  No gateway changes needed.

## 5. Tokenized-stocks feed (future product plumbing, built now)

`GET /api/stats/public` emits platform-wide, anonymized aggregates:
totals + 30-day zero-filled series of requests, tokens, inflow_usd (deposits) and
outflow_usd (spend). This series — sourced exclusively from `usage_events` and the
signed `ledger` — is the data substrate for the planned tokenized-stocks product
and for on-chain settlement of platform metrics.

## 6. Autonomous agents

Each agent (per user): system prompt, model (from catalog), MCP servers
(streamable HTTP, tools namespaced `mcp_<server>_<tool>`), optional cron, per-run
budget in USD micros, optional x402 flag. The runner loops ≤ max_steps:
LLM → tool calls (MCP, or `http_fetch` which pays 402-invoices from the agent
wallet via `x402-fetch` on Base) → final answer. Every step is billed to the user's
ledger; the run stops on insufficient balance or budget breach and is recorded in
`agent_runs` with spend and tool-call counts.

## 7. What is deliberately NOT in v1

- Key pooling / load balancing across multiple platform keys per provider
- Admin panel (cross-user usage, manual credits, pricing editor)
- WalletConnect mobile wallets (needs a WalletConnect projectId)
- The platform token itself, and the tokenized-stocks issuance layer
- On-chain settlement of credits (credits are off-chain ledger entries backed 1:1 by verified deposits)
