# 02 — Provider comparison and cost matrix

**Figures read 14 Nov 2026** from each provider's own pricing page (URL given per row). Free tiers
move; every number here carries the date it was read and must be re-read before a paid decision. Items
I could not verify from source are marked **UNVERIFIED** and are treated as blockers for commercial
use, not as small print.

---

## 1. The six providers, at a glance

| Provider | Role in Thirdeye | Free tier (read 14 Nov 2026) | First paid step | Verdict |
|---|---|---|---|---|
| **Neon Postgres** | primary relational DB + financial ledger | 100 projects; **100 CU-hrs/project/month**; 1 GB storage/project; 0.25 CU default size; scale-to-zero after 5 min; 6 h restore window; 5 GB object storage + 1 M function invocations (beta, no card) | Launch: **$0.106/CU-hr**, $0.35/GB-month | **Keep, no change.** Only add: versioned migrations and pgvector |
| **Cloudflare Workers** | lightweight edge services (probes, redirects, read-only status) | **100,000 requests/day**, 10 ms CPU/invocation | Paid $5/mo: 10 M req + 30 M CPU-ms, 5 min CPU max | **Narrow yes.** Read-only edge only. Never the ledger |
| **Cloudflare R2** | artifact and document blobs | **10 GB-month storage, 1 M Class A, 10 M Class B ops**, egress free | $0.015/GB-mo; $4.50/M Class A; $0.36/M Class B; 100 k buckets included | **Yes, for blobs only.** Postgres keeps the pointer and the hash |
| **Upstash Redis** | caching + distributed rate limiting | **250 MB, 10 GB bandwidth, 500 K commands/month**, 1 database, 10 k cmd/s | PAYG $0.20 per 100 K commands; $0.25/GB storage | **Yes, as a fast path.** Never as financial state |
| **Inngest** | durable workflows and scheduling | **50 K executions/month, 5 concurrent steps, 3 workers, 500 K events**, 30-day max run, 24 h trace history | Pro **$99/mo** (1 M executions). Free plan **pauses**, it does not meter overage | **Yes, expand.** Already installed; coverage is the gap |
| **Neon pgvector** | semantic retrieval / RAG | no extra charge — an extension on the existing project; consumes the same compute and storage | same as Neon | **Yes, after migrations land** |

Sources: `neon.com/pricing`; `developers.cloudflare.com/workers/platform/pricing/`;
`developers.cloudflare.com/r2/pricing/`; `upstash.com/pricing/redis`; `inngest.com/pricing`.

---

## 2. Per-provider detail

### 2.1 Neon PostgreSQL

- **Free-tier allowance.** 100 projects, each with its own **100 CU-hours per month**; 1 GB storage
  per project; autoscaling to 2 CU; scale-to-zero after 5 minutes idle; 6-hour point-in-time restore
  window or 1 GB of changes; one snapshot; 5 GB of Neon Object Storage and 1 M function invocations
  included (both beta); unlimited team members.
- **Technical limitations.** Compute is billed while *active*, so a busy hour costs the same whether
  it serves 10 requests or 10,000 — the constraint is wall-clock activity, not request count. Cold
  start after 5 minutes idle (~hundreds of ms). No SLA on Free. `pg` connections are limited and
  already pooled at `max: 5` per instance.
- **Production suitability.** High for this workload. At 0.25 CU, 100 CU-hours is roughly 400 active
  hours a month — about 13 hours a day — which is well above current traffic. The 1 GB storage cap is
  the number to watch once embeddings arrive: vectors are 4 bytes per dimension plus index overhead,
  so a 1536-dimension embedding is ~6 KB raw and roughly 8–10 KB with an HNSW index. **~100 k embedded
  chunks is the point where 1 GB starts to bind**, and 100 k chunks at 800 tokens each is ~80 M tokens
  of source text. That is a real ceiling, but not a near one.
- **Required environment variables.** `DATABASE_URL` (production), `PREVIEW_DATABASE_URL` (preview
  target only), optional `PGLITE_DIR` locally.
- **Integration complexity.** Zero — already the primary database.
- **Security.** Neon API key is a platform secret, used for admin only, never in the app runtime. The
  app talks Postgres over TLS. Preview isolation is already proven with a dedicated branch.
- **Migration and fallback.** No migration planned, and it should not be planned: this is the ledger.
  Fallback for local dev and CI is PGlite, which is not a production fallback and must never be
  presented as one. The one change worth making is that production should *refuse* to boot on PGlite
  rather than merely reporting it on `/api/healthz`.

### 2.2 Cloudflare Workers

- **Free-tier allowance.** 100,000 requests/day, 10 ms CPU per invocation, no charge for duration.
  Paid $5/mo raises it to 10 M requests and 30 M CPU-ms with up to 5 minutes CPU per invocation.
- **Technical limitations.** 10 ms CPU is enough to proxy, sign a short HMAC, read KV, or answer a
  health endpoint; it is not enough to run the Hono app, which imports `pg`, `viem`, `siwe` and
  `@modelcontextprotocol/sdk` and does crypto on every authenticated request. Workers has no TCP
  socket to Postgres without Hyperdrive, and no `pg` driver at all in the current shape.
- **Production suitability.** Good for exactly one category: **read-only edge surfaces** — an uptime
  probe that does not share a fate with Vercel, a redirect layer, a signed-URL minter for R2, a
  cache-header rewriter. Everything money-adjacent stays where the transaction is.
- **Required environment variables** (if adopted). `CF_API_TOKEN`, `CF_ACCOUNT_ID` for deploys;
  runtime secrets via `wrangler secret put` (never in the repo).
- **Integration complexity.** Medium: a separate deploy pipeline, a separate secrets store, and a
  second thing to monitor. This is why it is last in the plan.
- **Security.** A Worker holding an R2 signing key is a credential that can read every bucket object;
  scope it to one bucket with read-only object scope, and prefer pre-signed URLs handed out by the
  main app over a Worker that signs on demand from a public route.
- **Migration and fallback.** Additive only. Nothing in the current app depends on it, so the fallback
  is "delete the Worker". **Explicit non-goal:** do not migrate the backend to Workers — it would
  break `pg`, the Privy signing path and the settlement path in one move.

### 2.3 Cloudflare R2

- **Free-tier allowance.** 10 GB-month of Standard storage, 1 M Class A operations (writes, lists),
  10 M Class B operations (reads) per month, and **zero egress cost** at every tier. Deletes are free
  operations.
- **Technical limitations.** Class A and Class B are counted separately, so a chatty listing pattern
  burns the expensive class. Rounding is up to the next billing unit. The free tier applies to
  Standard storage only, and Infrequent Access carries a 30-day minimum storage duration plus
  retrieval fees — irrelevant for us, worth avoiding.
- **Production suitability.** High for the one thing Postgres should not store: bytes. Agent artifacts
  are already capped at 200 k characters of text, which is fine in a row; a PDF, an image or a crawled
  research page is not.
- **Required environment variables.** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET`, and optionally `R2_PUBLIC_BASE_URL`.
- **Integration complexity.** Low. The S3 API means `aws4fetch` (a few kB, no SDK) or the AWS SDK v3;
  presigned GET/PUT is one call. The design decision that matters is **the database stays the index**:
  `agent_artifacts` gains `storage_key`, `bytes`, `content_sha256` (already there) and `storage_class`,
  and Postgres remains the source of truth for what exists.
- **Security.** Bucket private by default; no public bucket; presigned URLs with short TTLs; objects
  keyed by content hash so a leaked key cannot be guessed; never put provider credentials or user
  PII in an object key.
- **Migration and fallback.** Dual-write first: write the row and the object, read from the object with
  a Postgres fallback. Only after a full month of matching hashes does the object become the only copy.
  On any R2 error, fall back to the row — an artifact write must never fail because a bucket is down.

### 2.4 Upstash Redis

- **Free-tier allowance.** 250 MB data, 10 GB monthly bandwidth, **500,000 commands/month**, one
  database, up to 10,000 commands per second, TLS.
- **Technical limitations.** 500 k commands/month is the binding number, not the 250 MB. A limiter
  that costs two commands per metered request therefore covers **~250,000 metered requests per month**
  on the free tier; a pipelined `INCR` + `EXPIRE` can be one round trip but both still count. Over the
  limit, writes can be blocked and bandwidth capped — which for a limiter means failing closed, so the
  Postgres path must remain the fallback and must be *tested* as the fallback.
- **Production suitability.** Good for: rate-limit counters, provider response cache with short TTLs,
  health-check state, and de-duplication of hot reads. Bad for: balances, ledger rows, deposit state,
  session authority, or anything a restart may not legally lose. Redis here is a cache, never a book
  of record.
- **Required environment variables.** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- **Integration complexity.** Low (REST, no connection pool, works from serverless), but the *policy*
  work is real: shadow mode, a fallback path, and a rule that a Redis outage degrades performance and
  never correctness.
- **Security.** The REST token is a full-database credential; scope it to one database, keep it in the
  platform secret store, and never expose it to the browser. Namespace every key (`rl:`, `px:` prefixes)
  so a future multi-tenant split is possible without a migration.
- **Migration and fallback.** Phase 1 shadow: compute both, log divergence, enforce Postgres. Phase 2:
  enforce Redis, fall back to Postgres on error or timeout (200 ms budget) and emit an alert. Never
  "fail open to unlimited".

### 2.5 Inngest

- **Free-tier allowance.** 50,000 executions/month, 5 concurrent steps, 5 seats, 3 workers, 500 k
  events, 100 k queue depth, 50 realtime connections, 30-day maximum run length, 24-hour trace
  history, 500 MB span data.
- **Technical limitations, and the one that matters.** An execution is metered **per run and per step**
  — a 5-step function costs 6. The free plan has **no metered overage: execution pauses** when the
  quota is hit. For `convert-pending-deposits` that is a silent stop of a money-adjacent job. A
  multi-step agent run at 12 steps therefore gives ~3,800 runs/month on free; Pro is $99/mo for 1 M.
- **Production suitability.** High. It is already installed, already mounted and already returns a
  clean 503 when unconfigured. Coverage is the gap, not the vendor.
- **Required environment variables.** `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (both present in
  production).
- **Integration complexity.** Low for the SDK, medium for the *change of thinking*: work becomes
  step-scoped and idempotent, and the idempotency key has to be chosen deliberately.
- **Security.** Signing key verifies inbound requests; the serve route returns 401 unsigned. Event
  payloads must not carry secrets. Dead-letter/failed-run visibility is not a substitute for our own
  `agent_alerts`.
- **Migration and fallback.** Move scheduled agent runs from the Vercel cron to Inngest **while
  keeping** `POST /api/cron/agents` as the ops trigger and the schedule lock as the duplicate guard.
  Add an independent `last_success` heartbeat so a paused Inngest function alerts through our own
  monitor instead of going quiet.

### 2.6 Neon pgvector

- **Free-tier allowance.** No separate charge: `CREATE EXTENSION vector` on the existing project.
  Vectors cost storage and index build CPU against the same 100 CU-hours and 1 GB.
- **Technical limitations.** HNSW index build is CPU-heavy and memory-hungry; on a 0.25 CU compute it
  is slow enough that the index should be built on a branch first and measured. `pgvector` has no
  built-in hybrid ranking — BM25/`tsvector` plus vector distance must be combined in SQL or in the app.
- **Production suitability.** High, with one rule: **the extension must be optional at runtime.**
  PGlite (used by every test) loads pgvector as a separate module, so the code has to detect an absent
  extension and degrade to keyword search rather than fail a request.
- **Required environment variables.** none beyond `DATABASE_URL`. A `KNOWLEDGE_EMBEDDING_MODEL` and
  the embedding provider's key are needed for the *ingestion* side.
- **Integration complexity.** Medium: schema, index tuning, a chunker, an embedder (and its cost),
  and a retrieval tool for agents.
- **Security.** Retrieved documents are untrusted input. They must never be interpolated as
  instructions, and every retrieved passage shown to a user or an agent must carry its source URL and
  fetch timestamp so a claim can be traced.
- **Migration and fallback.** Additive columns and tables; keyword-only fallback if the extension or
  the embedder is unavailable. No existing query changes behaviour.

---

## 3. Cost matrix

Three profiles, costed per month. "Today" is the current measured volume; 10× and 100× are the next two
rungs. **No card is required for any profile below at the "today" line**, which is the point: the plan
must be free at current scale and cheap at 10×.

| Line item | Today (~10 k metered requests, ~22 agent runs, <1 GB artifacts) | 10× (100 k requests, ~1 k runs, 20 GB artifacts) | 100× (1 M requests, ~20 k runs, 200 GB artifacts) |
|---|---|---|---|
| Neon compute | **$0** (well under 100 CU-hrs) | **$0** (~60 CU-hrs at 0.25 CU × 8 h/day) | ~$0–$11 (100 CU-hrs free, then $0.106/CU-hr) |
| Neon storage | **$0** (<1 GB) | **$0** | $0–$35 (1 GB free, then $0.35/GB-mo) if blobs stay in Postgres; **$0** if they move to R2 |
| R2 | **$0** | **$0** (20 GB → 10 GB billable = $0.15) | ~$2.85 (190 GB billable) + ops ~$0–$1 |
| Upstash Redis | **$0** (far under 500 k commands) | **$0** at 1 cmd/request; **~$0.20** at 2 | **~$4** (2 M commands at $0.20/100 k) |
| Inngest | **$0** (~130 executions) | **$0** (~6 k executions) | **$99/mo** (260 k executions > 50 k free; the free plan *pauses*) |
| Workers (optional edge) | **$0** | **$0** (probes ≪ 100 k/day) | **$0–$5** |
| **Total** | **$0** | **$0–$0.35** | **~$6–$142**, dominated by the Inngest step |

What this table says, in one line each:

- **The only unavoidable cliff is Inngest at 100×**, and it is a *pause*, not a bill. That is a
  availability risk before it is a cost risk.
- **Storage is cheaper in R2 than in Neon beyond ~1 GB** ($0.015 vs $0.35 per GB-month, egress free on
  both). R2 for blobs, Postgres for the row. Embeddings are the exception: vectors belong next to the
  data they rank.
- **Upstash is not a cost decision at our volume** — it is a latency and availability decision. At
  250 k requests/month it costs under a dollar, so it should be adopted only if it demonstrably reduces
  database round trips.

---

## 4. What I would not adopt, and why

| Not adopting | Reason |
|---|---|
| Moving the whole backend to Cloudflare Workers | Breaks `pg`, the Privy signing path and the settlement path; the brief forbids it; the financial ledger needs a real transaction |
| Redis as a balance or ledger store | Balance reads would become non-durable. Non-negotiable |
| Vercel KV / Vercel Blob | Vercel-marketplace storage is priced per operation and per GB with no meaningful free tier for artifacts; R2 wins on egress and near-line storage |
| A second Postgres (Supabase/PlanetScale/etc.) | Two databases is two truths. Branching already covers previews and tests |
| pgvector on PGlite as the only path | PGlite is a test/dev substrate; the extension exists there but must be optional |
| Any paid data provider before a licence review | See `04` — free access is not a commercial licence |

---

## 5. Open decisions that need Sam, not me

1. **Embedding provider.** Ingestion needs an embedder; nothing free is funded today. Options:
   BYOK OpenAI `text-embedding-3-small` (cheap, but a key is required and it is a third party receiving
   our document text), a local model behind a Worker (no vendor, more moving parts), or deferring
   embeddings and shipping keyword/hybrid search first. **Recommendation: ship keyword search first,
   then decide**, because retrieval quality can be measured against the same corpus either way.
2. **Inngest Pro at $99/mo** only becomes relevant at roughly 20,000 multi-step runs/month. Not now.
3. **Whether an R2 bucket is acceptable for archived agent artifacts that may contain user prompts.**
   It is a data-residency question, not a technical one.
