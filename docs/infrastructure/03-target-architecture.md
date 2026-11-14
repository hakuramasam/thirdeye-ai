# 03 — Proposed architecture and dependency assessment

This document describes the target shape, the modules it adds, the dependencies it does and does not
take on, and how each new piece fails. It is a proposal: nothing here is implemented, and nothing here
changes a working component without a stated reason (audit: `01`).

---

## 1. Principles

1. **Postgres is the book of record.** Money, deposits, usage, audit, provenance and artifact metadata
   live in Neon. Everything else is a cache, a blob, or a fast path in front of it.
2. **Fail closed on money, fail open on experience.** A cache miss falls through to Postgres; an
   unknown payment state refuses to credit.
3. **Every external answer carries its passport.** Source, URL, fetch time, observation time, provider,
   reliability tier, freshness window, cost. A fact without provenance is not usable in a product whose
   selling point is measured truth.
4. **The interface is older than the provider.** Providers are swapped behind capability interfaces, so
   a dead vendor is a config change, not a refactor.
5. **Nothing new runs on the request path until it can be rolled back with one env var.**
6. **Serverless budget is a design constraint, not an excuse.** 60 s per invocation, 1024 MB, one app.
   Anything longer is a durable workflow.

---

## 2. Target shape

```
                            ┌──────────────────────────────────────────┐
   browser / API client ───▶│ Vercel: single Hono app (api/index.ts)    │
                            │  auth · keys · billing · routes           │
                            └───────┬───────────────┬──────────────────┘
                                    │               │
              ┌─────────────────────▼──┐         ┌──▼────────────────────────┐
              │ src/data/registry      │         │ src/knowledge/ (RAG)      │
              │ capability interfaces  │         │ ingest → chunk → embed    │
              │ throttle · cache ·     │         │ hybrid search over pgvec  │
              │ provenance · fallback  │         └──┬────────────────────────┘
              └───┬───────────┬────────┘            │
                  │           │                     │
   ┌──────────────▼──┐   ┌────▼─────────────┐   ┌───▼───────────────────────┐
   │ src/storage/    │   │ Upstash Redis    │   │ Neon Postgres             │
   │ blobs.ts        │   │ cache + limiter  │   │ ledger · audit · vectors  │
   │ R2 ⟷ Postgres   │   │ (never money)    │   │ (authoritative)           │
   └─────────────────┘   └──────────────────┘   └───────────────────────────┘
                  │
        ┌─────────▼──────────────────────────────────────────────┐
        │ Inngest: scheduled agent runs, settlement, conversions │
        └─────────┬──────────────────────────────────────────────┘
                  │
        ┌─────────▼──────────────┐        ┌────────────────────────────┐
        │ Cloudflare Worker      │        │ Provider APIs              │
        │ read-only edge probes  │        │ Brave · Tavily · RSS · Jina│
        │ (optional, last)       │        │ Alchemy · Graph · Blockscout│
        └────────────────────────┘        │ CoinGecko · DEXS · Binance │
                                          │ DefiLlama · GeckoTerminal  │
                                          └────────────────────────────┘
```

---

## 3. Layers

### 3.1 Data provider registry — `src/data/`

New. Nothing like it exists today: `src/data/` currently holds one file (`changelog.ts`).

| Module | Responsibility |
|---|---|
| `types.ts` | Capability request/response types, `Provenance`, `ProviderError`, `Freshness` |
| `registry.ts` | Registration, capability resolution, health state, ordered fallback chains |
| `throttle.ts` | Per-provider token bucket, shared via Redis when present, in-process otherwise |
| `transport.ts` | One bounded fetch: deadline, ≤2 retries honouring `retry-after`, 2 MiB cap, JSON guard, **existing `src/lib/ssrf.ts` guard on every URL** |
| `cache.ts` | Freshness-aware response cache; key = capability + normalised args; TTL by capability class |
| `usage.ts` | Writes `provider_usage` rows (provider, capability, count, cost_micros, latency, ok) |
| `health.ts` | `provider_health` rows + a probe used by readiness and by the monitor's detectors |
| `providers/*.ts` | One file per vendor; each exports capabilities it can serve, never a generic `fetch` |

Design detail in `04-data-provider-registry.md`.

### 3.2 Data intelligence — `src/knowledge/`

New. `/api/v1` and the agents gain a `knowledge_search` capability backed by it.

```
documents ──dedupe(sha256)──▶ document_chunks ──embed──▶ chunk_embeddings (vector)
     │                              │
     └── provenance jsonb           └── tsv (keyword) for hybrid ranking
```

- Ingestion is a **durable** job (Inngest step per document), never inline in a request.
- Retrieval is a single SQL statement combining `ts_rank_cd` and cosine distance, with the weights
  configurable, so hybrid ranking does not become an app-side sort of two result sets.
- Chunking, embedding source, retention and the fallback when no embedder is configured are specified
  in `05-data-intelligence.md`.

### 3.3 Storage — `src/storage/blobs.ts`

New, thin, and boring on purpose:

```ts
type BlobStore = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; bytes: number }>
  get(key: string): Promise<Uint8Array | null>
  signGet(key: string, ttlSeconds: number): Promise<string>
}
```

- `agent_artifacts` gains `storage_key`, `storage_class`, and keeps `content_sha256` as the dedupe key.
- Artifact text under 32 KB stays in the row (cheap, transactional, no second system in the path).
  Anything larger, and every binary, goes to R2 with the row as the index.
- R2 failure falls back to the row. A read of a missing object falls back to the row.

### 3.4 Cache and rate limiting — `src/lib/cache.ts` + `ratelimit.ts`

- `ratelimit.ts` keeps its Postgres implementation as the **authority** and gains an optional Redis
  fast path: `INCR` + `EXPIRE` in one pipeline, a 200 ms budget, and a Postgres fallback on any error
  or timeout. Shadow mode first (compute both, log divergence, enforce Postgres).
- New `src/lib/cache.ts`: `getOrCompute(key, ttlMs, fn)` with a Redis backend and an in-process LRU
  fallback. Used by provider responses and by expensive public reads. **Never** by balance, ledger or
  deposit reads — those must be single-sourced.

### 3.5 Durable workflows — Inngest

Expand from two functions to a small, explicit set:

| Function | Trigger | Why durable |
|---|---|---|
| `convert-pending-deposits` (exists) | `*/10 * * * *` + event | already correct; fix the missing `ops_events` table |
| `team-agent-run` (exists) | `thirdeye/team.run` | agent runs outlive 60 s |
| `scheduled-agent-tick` (new) | `*/5 * * * *` | replaces the single daily Vercel cron; each due agent becomes a `step.run` |
| `knowledge-ingest` (new) | `thirdeye/knowledge.ingest` | crawl → chunk → embed is minutes, not seconds |
| `provider-health-probe` (new) | `*/15 * * * *` | independent of any user request |

Each carries its own idempotency key. The Vercel cron stays as a belt-and-braces trigger and the
`agent_schedule_lock` table stays as the duplicate guard, so two trigger paths cannot double-run an
agent.

---

## 4. Dependency assessment

The bundle already imports `pg`, `viem`, `siwe`, `@modelcontextprotocol/sdk`, `hono`, `react` and
`inngest` in a 1024 MB function with a 60 s ceiling. Every new dependency is cold-start cost on the
paid path, so the default answer is **no new dependency**.

| Need | Proposed | Verdict |
|---|---|---|
| R2 S3 API | `aws4fetch` (~5 kB, MIT) | **Add.** SigV4 in 200 lines is a bug farm; this is the smallest correct option |
| Upstash Redis | **no package** — `fetch` against the REST API (`/pipeline`) | **No dependency.** The API is two headers and a POST |
| pgvector | **no package** — `CREATE EXTENSION` + SQL casts | **No dependency** |
| Embeddings | none until the provider decision in `02` §5 | **Deferred** |
| Token bucket | in-repo (`throttle.ts`) | **No dependency.** ~40 lines, testable |
| Provider HTTP | in-repo (`transport.ts`) + existing `ssrf.ts` | **No dependency** |
| Inngest | present (4.26.2) | **Keep** |

Net new runtime dependencies for the whole plan: **one** (`aws4fetch`), and only when the R2 PR lands.

---

## 5. Failure map

The point of this table is that every new component has an answer for "what happens when it is down".

| Component down | Effect | Behaviour |
|---|---|---|
| Upstash Redis | limiter and cache unavailable | Fall back to Postgres limiter and no cache. Alert. Correctness unchanged |
| R2 | new large artifacts cannot be stored | Row is still written; `storage_key` null; retried by a durable job. Reads fall back to the row |
| Inngest paused (quota) | scheduled runs stop silently | `last_success` heartbeat compared to `now()` in the monitor raises a HIGH alert |
| Neon | everything financial stops | `/api/livez` stays 200, `/api/healthz` reports the failure class, writes refuse rather than degrading to PGlite in production |
| A data provider | that capability degrades | Ordered fallback chain, then a typed `provider_unavailable` error carrying provenance. Never a fabricated value |
| Embedding provider | no new vectors | Keyword-only retrieval; ingestion queues rather than failing |
| Cloudflare Worker | edge probe silent | Nothing in the app depends on it; its own absence is visible on the status page |

---

## 6. Explicit non-goals

- No migration of the backend to Cloudflare Workers, in whole or in part beyond read-only edge helpers.
- No replacement of Neon, and no second author of financial state.
- No provider failover on any path that writes, signs, sends or credits. Failover is for **reads**.
  A retried read is free; a retried transfer is a duplicate payment.
- No paid service adopted before its cost is in `02` and its licence is reviewed in `04`.
- No change to the model provider adapters.

---

## 7. Where existing files change

| File | Change | Reason |
|---|---|---|
| `src/db/schema.sql` | new tables + columns | data, knowledge, provenance |
| `src/db/migrate.ts` (new) | versioned runner + `schema_migrations` | audit risk #1 |
| `src/lib/env.ts` | new optional vars (`R2_*`, `UPSTASH_*`, `DP_*`, `KNOWLEDGE_*`), grouped | one config surface |
| `src/lib/ratelimit.ts` | optional Redis fast path, Postgres authority retained | latency, availability |
| `src/agents/artifacts.ts` | `storage_key` / hybrid store | blobs |
| `src/inngest/functions.ts` | new functions, fix `ops_events` | durability, audit risk #6 |
| `src/agents/runner.ts` | model rotation on rate limit | audit risk #3 |
| `vercel.json` | no change (cron retained as a secondary trigger) | avoid a flag day |
| `.env.example` | every new var documented | acceptance criterion |

Nothing in the financial paths changes except where `05` and PR #41 interact, and that is stated
explicitly in `07`.
