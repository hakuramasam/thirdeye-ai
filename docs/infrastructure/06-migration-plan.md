# 06 — Migration plan

One PR per component, each independently reviewable and independently revertible. No flag day, no
big-bang rewrite, no PR that mixes a schema change with a vendor integration.

**Sequencing rule:** a PR may depend on an earlier PR merging, never on an earlier PR being *in
review*. Everything below is ordered by that constraint.

---

## 0. Phases

| Phase | PRs | What it unlocks | Merge order |
|---|---|---|---|
| **0. Record** | PR-A | the audit, matrix, architecture, plan, security plan | now |
| **1. Foundations** | PR-B, PR-C | schema you can version; a provider layer that cannot SSRF | B → C |
| **2. Data in** | PR-D1, PR-D2 | real external data with provenance and cost | D1 → D2 |
| **3. Resilience** | PR-E, PR-H | limiter that survives DB pressure; runs that survive 60 s | E and H independent |
| **4. Memory** | PR-F, PR-G | blobs and searchable knowledge | F, then G |
| **5. Edge** | PR-I | independent liveness (optional) | last |

---

## PR-A — This document set

- **Scope.** `docs/infrastructure/*` only. Zero code, zero schema, zero config.
- **Risk.** None. The only failure mode is being wrong on paper, which review is for.
- **Rollback.** Revert.
- **Acceptance.** Existing suite unchanged and green (nothing touched); every claim traceable to a file
  path or a provider page with a date.

---

## PR-B — Versioned migrations

**Why first:** every later PR adds tables, and today the only migration mechanism is a 603-line
idempotent file with an in-process boolean and no record of what ran.

- **Scope.**
  - `schema_migrations (version text primary key, applied_at timestamptz, checksum text, ms integer)`.
  - `src/db/migrations/0001_baseline.sql` = today's `schema.sql`, unchanged, so an existing production
    database and a fresh one converge on the same state.
  - `src/db/migrate.ts`: ordered runner, `pg_advisory_lock`, one transaction per file where the DDL
    allows it, checksum verification, and a refusal to run if a previously applied file changed.
  - `migrate()` keeps its call site and its behaviour; it gains an ordering guarantee and a record.
  - **Keep the existing deployment refusal, and test it.** `validateDatabase()` already refuses a
    deployment with no `postgres://` URL and `config-guard.ts` already 503s with the variable named.
    This PR adds no new control — it adds the regression test that stops a future refactor from
    deleting the one that exists.
- **Non-goals.** No data backfills, no schema changes, no ORM.
- **Tests.** Fresh PGlite → all migrations; run twice → idempotent; alter an applied file → refuses;
  simulate a mid-file failure → no `schema_migrations` row, database unchanged where transactional;
  a serverless boot with no connection string still 503s naming the variable (regression guard for
  `validateDatabase`).
- **Rollout.** Merge and deploy: production runs `0001` once, records it, and nothing else changes.
  Verify with `/api/healthz` (measured database) and by reading `schema_migrations`.
- **Rollback.** Code revert; the new table is inert.
- **Risk.** Low–medium. The one dangerous moment is the first production boot, which either records the
  baseline or fails closed. Test on a Neon branch first.
- **Size.** M.

---

## PR-C — Provider registry core

**Why second:** everything in phase 2 needs it, and it is the piece most likely to be wrong in a
subtle way (retries, SSRF, deadlines), so it lands alone and tested.

- **Scope.** `src/data/{types,registry,transport,throttle,health,cache,usage}.ts` plus **one** provider:
  `providers/rss.ts` (`web.feed`) — keyless, licence-clean, and a genuine use case (feeds are how a
  research agent reads news without a paid search API).
- **Schema.** `provider_usage`, `provider_health` (both append-only), and a `providers` config table is
  *not* created — provider config stays in code so a config row cannot enable a vendor the code does not
  know.
- **Non-goals.** No market/chain providers, no Redis, no caching backend, no R2.
- **Reuses, does not reimplement:** `src/lib/ssrf.ts` for egress, the existing `query`/`one` helpers,
  and `scrub()` from the monitor for error text.
- **Tests.** The ten tests listed in `04` §8, plus: a feed with a 3 MiB body is refused at the cap; a
  feed whose self-link points at a private address is refused by `ssrf.ts`; the whole suite runs with
  outbound HTTP disabled.
- **Rollout.** Nothing calls it in production yet except one internal probe route (`/api/healthz`
  extension) — the registry ships dark.
- **Rollback.** Delete the module; nothing depends on it.
- **Size.** L.

---

## PR-D1 — Market and chain providers on the registry

- **Scope.** Migrate `GeckoTerminal` (already in production and already `approved`) onto
  `market.pools`, then add `DefiLlama` (`defi.protocols`) and `DEX Screener` (`market.pools`,
  `market.quote`). Add the licence gate: `pending` providers are refused when `NODE_ENV=production`.
- **Why GeckoTerminal first:** it is the one provider already carrying money-adjacent reads. Moving it
  behind the registry is what proves the abstraction on a path that matters, with a fallback (DEX
  Screener) that did not exist before.
- **Non-goals.** No CoinGecko, no The Graph, no Blockscout, no search providers. Those need terms
  review (see `04` §5), not code.
- **Safety.** Deposit pricing keeps its existing guards (`minLiquidityUsd`, pool checks). The registry
  may never be the sole authority for a credit decision: if every price provider fails, the deposit is
  refused, not priced from cache older than its freshness policy.
- **Tests.** Fallback proven with fixtures; identical price from two providers produces identical
  normalised output; a stale cache never satisfies `requireFreshMs`.
- **Rollout.** Shadow: call the registry alongside the existing code path, compare values for a week,
  then switch the read. That is one env flag (`DATA_PRICE_SOURCE=legacy|registry`).
- **Rollback.** The flag.
- **Size.** M–L.

---

## PR-D2 — Web research providers

- **Scope.** `Brave` (`web.search`, `web.fetch`) and `Tavily` (`web.search`, `web.extract`) behind
  `web.search`, both `pending` until their terms are read; `Jina` only after its free allowance is
  verified.
- **Non-goals.** No crawling, no scheduling, no agent wiring (that is PR-G's consumer).
- **Tests.** Recorded fixtures per provider; a 429 with `retry-after: 30` falls through instead of
  sleeping; a provider returning a non-JSON body is `bad_response`.
- **Rollout.** `pending` in production means the capability answers `licence_pending`. Flipping the
  flag is a one-line, reviewable change *after* the terms review is written down in `04` §5.
- **Size.** M.

---

## PR-E — Upstash Redis for rate limiting (shadow, then enforce)

- **Scope.** `src/lib/ratelimit.ts` gains a Redis fast path (REST, `fetch`, no new dependency), a
  200 ms budget, and a Postgres fallback. Phase 1 shadow: compute both, enforce Postgres, record
  divergence. Phase 2 enforce Redis with Postgres fallback.
- **Hard rules.**
  - Redis is never the authority for a *financial* fact. It holds counters, not balances.
  - A Redis outage degrades latency and never correctness.
  - A rate-limit decision that cannot be made falls back to Postgres; it never fails open to unlimited.
- **Tests.** Divergence test between shadow and authority; Redis timeout → Postgres answers within
  budget; a forced error → alert row, requests still limited; key namespacing.
- **Rollout.** Env flags `RATE_LIMIT_BACKEND=postgres|shadow|redis`. Shadow for at least a week of real
  traffic before enforcing.
- **Rollback.** The flag, instantly.
- **Size.** M.

---

## PR-F — R2 for artifact blobs

- **Scope.** `src/storage/blobs.ts` (`put`/`get`/`signGet`), `agent_artifacts` gains `storage_key`,
  `storage_class`; text ≤32 KB stays inline, larger text and all binaries go to R2.
- **New dependency:** `aws4fetch` only (see `03` §4).
- **Non-goals.** No migration of existing rows (they stay inline forever — they are small), no public
  bucket, no CDN.
- **Safety.** Dual-write with the row as the index; an R2 failure never fails an artifact write; object
  keys are content-hash based; GETs are presigned with a short TTL.
- **Tests.** Write → read round trip against a mocked S3 endpoint; R2 error → row still written and
  readable; hash mismatch on read → refusal, not corrupted content; presigned URL expiry honoured.
- **Rollout.** `BLOB_BACKEND=postgres|r2` with dual-write first.
- **Rollback.** The flag; objects become orphaned temporarily, rows remain complete.
- **Size.** M.

---

## PR-G — Knowledge engine

Split deliberately into two merges:

**G1 — keyword, no vectors.** `documents`, `document_chunks`, chunker, dedupe, retention job,
`knowledge_search` in keyword mode, ingestion as an Inngest function. Works with no embedding provider.
**G2 — pgvector backfill.** `CREATE EXTENSION vector` on a branch, HNSW index, hybrid query, backfill
of `embedding IS NULL` rows, PGlite vector extension registered in the test harness with a graceful
fallback when absent.

- **Safety.** Retrieved text is data, never instruction (`05` §7); every passage carries URL and
  fetch time; retention defaults to 180 days; the corpus is capped so it cannot eat the Neon free tier.
- **Tests.** Chunker boundaries and overlap; dedupe by hash across publishers; TTL deletion removes
  chunks; keyword search ranking is stable; hybrid weights are covered by a labelled query fixture;
  missing extension → keyword mode, not an exception; prompt-injection fixture is stored and returned
  verbatim but changes no tool or budget.
- **Rollout.** G1 dark (tool available to no agent until an agent's allowlist names it), then G2 on a
  branch, then a measured index build before enabling.
- **Rollback.** `KNOWLEDGE_SEARCH=off`; the tables are additive.
- **Size.** G1 M, G2 M.

---

## PR-H — Durable scheduled runs and model rotation

**Why it matters most for reliability:** three consecutive scheduled runs died on a free-tier 429 that
the retry budget could not outlast, and a run closed by the outer catch records zero spend and zero
tool calls.

- **Scope.**
  - `scheduled-agent-tick` Inngest function (`*/5 * * * *`), one `step.run` per due agent, keeping
    `agent_schedule_lock` as the duplicate guard and `POST /api/cron/agents` as a manual trigger.
  - Model rotation on `isRateLimitError`: walk the catalogue's funded models rather than sleeping
    inside a 60 s function.
  - Fix the `ops_events` insert (`src/inngest/functions.ts:34`) — create the table in a migration or
    remove the dead write; either way, stop swallowing it.
  - A `last_success` heartbeat per scheduled function, compared to `now()` by a new monitor detector,
    so an Inngest pause alerts through our own system.
- **Non-goals.** No change to what agents may do, no change to budgets, no new tools.
- **Tests.** Duplicate trigger → one run (lock); rate limit on model 1 → model 2 completes the same
  run; quota-pause simulation → heartbeat detector raises HIGH; `ops_events` write either succeeds or
  raises.
- **Rollout.** Both triggers live simultaneously for a week; compare run counts, then remove the
  daily Vercel cron only if the counts agree.
- **Rollback.** Disable the Inngest function; the Vercel cron is still there.
- **Size.** M.

---

## PR-I — Cloudflare Worker liveness probe (optional, last)

- **Scope.** A Worker (cron-triggered) that GETs `/api/healthz` and `/status` from three regions and
  writes the result to a KV key or an R2 object the status page reads.
- **Why optional.** It is the only way to detect "Vercel is down" from outside Vercel, which is a real
  gap — but it is not urgent, and it adds a second deploy pipeline.
- **Security.** Read-only. No app credentials. No signing keys.
- **Rollback.** Delete the Worker.
- **Size.** S.

---

## 1. Dependency graph

```
PR-A (docs)
  └─ PR-B (migrations) ─┬─ PR-C (registry core) ─┬─ PR-D1 (market/chain providers)
                        │                        └─ PR-D2 (web research)
                        ├─ PR-E (redis limiter)      [independent]
                        ├─ PR-F (r2 blobs) ── PR-G1 (knowledge, keyword) ── PR-G2 (pgvector)
                        ├─ PR-H (durable runs)       [independent]
                        └─ PR-I (edge probe)         [independent, optional]
```

Parallel-safe: B, then {C, E, F, H} can proceed concurrently; D and G depend on C and F respectively.

---

## 2. Schema change discipline

Every PR that touches `schema.sql`:

1. adds a new `src/db/migrations/00NN_*.sql` file (never edits an applied one);
2. uses `IF NOT EXISTS` / additive columns only — no destructive change in the same PR that adds a
   feature;
3. is tested on a **Neon branch** cloned from production before merge, not on PGlite alone;
4. notes the index build cost in the PR body (an HNSW build is minutes of compute on a 0.25 CU compute
   and eats the free CU-hours);
5. confirms `/api/healthz` still reports the database as reachable after deploy.

---

## 3. Mapping to the brief's acceptance criteria

| Criterion | How each PR satisfies it |
|---|---|
| Existing functionality remains operational | Every PR is additive; feature flags default to today's behaviour; no PR removes a code path it does not replace |
| TypeScript checks pass | Required `verify` check on every PR (`tsc --noEmit` + suite) |
| Existing tests remain green | The suite is the gate; a PR that needs an existing test changed must say why in the body |
| New integrations have automated tests | Each PR's "Tests" section above; zero-network suite for provider work |
| Provider failures are handled safely | `04` §4: deadlines, bounded retries, breaker, typed errors; failover on reads only |
| No production secrets are exposed | `DP_*` names, AES-GCM reuse, never in a response/log/artifact; review checklist in `07` |
| Database persistence is verified | Neon-branch test + `/api/healthz` measurement after deploy + a row-level readback in the PR |
| Usage and cost limits are measurable | `provider_usage` (cost micros), existing `usage_events` (user billing), Inngest execution count, Redis command count |
| Documentation is updated | `docs/infrastructure/*` updated in the same PR that changes the behaviour, plus `.env.example` |

---

## 4. What this plan deliberately does not do

- It does not touch the payment path until PR #41 (payment finality) is merged. `07` §4 explains why
  building on top of unchanged first-read crediting would be worse than waiting.
- It does not add a paid vendor. Everything in phases 1–4 is free-tier at current volume.
- It does not move the backend to Workers, and it does not replace Neon.
- It does not enable a data provider whose terms nobody has read, however generous its free tier looks.
