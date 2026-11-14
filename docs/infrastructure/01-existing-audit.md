# 01 — Existing infrastructure audit

**Baseline:** `main` at `4723be0` (14 Nov 2026). Every claim below was read from that tree or from
the providers' published docs on the date shown. Nothing in this document is a proposal; proposals
start at `02`.

**Scope:** what runs today, how each piece is wired, what is genuinely load-bearing, and what would
break first as traffic grows. Components that work are marked **keep** — the brief forbids replacing
a working component without a documented reason, so reasons are written down where a change is
recommended.

---

## 1. Deployment and execution

| | |
|---|---|
| Host | Vercel, Node serverless |
| Entry | `api/index.ts` — exports named HTTP verbs wrapping `handle(app)` from `hono/vercel` |
| App | `src/app.ts` (Hono), routes in `src/routes/*` |
| Function config | `vercel.json` → `api/index.ts`, **memory 1024 MB, maxDuration 60 s** |
| Static | React SPA built by Vite into `web/dist`, served by Vercel |
| Routing | Every `/api/*` path rewrites to `/api`; each server-rendered page (`/status`, `/docs`, `/team`, …) gets an explicit rewrite so it reaches the function instead of the SPA catch-all |
| Scheduled work | exactly **one** Vercel cron: `/api/cron/agents` at `0 9 * * *` (09:00 UTC) |

Two consequences that shape everything else:

1. **One process, 60 seconds.** There is no worker tier, no queue, no background thread. Any unit of
   work that can outlive 60 s (a delegating agent run, a long provider call, a settlement that must
   happen after the response) has to be either bounded below 60 s or handed to Inngest. This is not
   theoretical: the streaming true-up bug and the cron-run failures were both this limit.
2. **One cron per day** on the current plan. Per-agent sub-daily cadences already depend on an
   external pinger hitting `POST /api/cron/agents` with `Authorization: Bearer $CRON_SECRET`.

**Documentation drift found:** `README.md` says the cron fires at 18:30 UTC; `vercel.json` says
09:00 UTC. The config is authoritative. Fix the README rather than the cron.

---

## 2. Database

| | |
|---|---|
| Driver | `src/db/index.ts` — `pg` `Pool` (max 5) when `DATABASE_URL` is set, else `@electric-sql/pglite` |
| Previews | `src/lib/env.ts` prefers `PREVIEW_DATABASE_URL`, which is unset in production |
| Migrations | a single idempotent `src/db/schema.sql` (603 lines, **33 tables**) executed by `migrate()` on first use, guarded by an in-process boolean |
| Authoritative ledger | `ledger`, `deposits`, `payments`, `payment_intents`, `usage_events`, `credit_allowances` — all Postgres |
| Vector support | **none.** No `vector` column, no embeddings table, no full-text index (`tsvector`/GIN) either |

`migrate()` is a good bootstrap and a poor migration system. It is idempotent because every statement
is `IF NOT EXISTS`, but it cannot express a data backfill, an ordering between two changes, a
destructive change, or a rollback, and a failure halfway through leaves the database in a partial
state with no record of how far it got. **This is the single highest-leverage fix in the plan**, and
it is a prerequisite for every new table the rest of this brief adds.

Two runtime characteristics to keep in mind:

- **PGlite is a fallback, not a mode, and the deployment refusal is already in place.** With
  `DATABASE_URL` absent on Vercel the driver would bind `memory://`, so a misconfigured deploy would
  serve an empty database and discard every write. `validateDatabase()` in `src/lib/security.ts`
  refuses that: on serverless or `NODE_ENV=production` it emits a `SecretProblem` naming the variable
  actually in play (`PREVIEW_DATABASE_URL` on a preview, else `DATABASE_URL`), and
  `src/lib/config-guard.ts` turns it into a 503 plus a truthful `/api/healthz`. WO-01 (`4f10ac8`,
  live) added the measured liveness/readiness split: `/api/healthz` probes the database under a
  bounded timeout and reports only a failure class, while `/api/livez` never touches it, so an outage
  cannot become a restart loop. **This control must be preserved, not re-invented, by any change in
  this brief.**
- **Pool size 5 per instance.** Fine at current volume; the first thing to saturate under
  concurrency, and the reason a cache matters before a queue does.

---

## 3. Rate limiting and caching

`src/lib/ratelimit.ts` implements a fixed window in **Postgres**: one atomic upsert per request into
`ratelimit_counters`, keyed by API key id, with a namespaced bucket string (`auth:verify:<hash>`) for
unauthenticated endpoints so no raw client IP is stored. TPM is estimated from the request.

**Keep** — it is correct, atomic, and sits next to the ledger it protects. What it is not:

- free: it adds a write to the hot path on every metered request;
- distributed-cheap: every window check is a database round trip;
- burst-proof: a fixed window admits 2× the limit across a boundary;
- available during a database incident, which is exactly when abusive traffic is most expensive.

This is the only place where an external cache clearly earns its place, and it must be added as a
*fast path with a Postgres fallback*, never as the authority.

---

## 4. Agent execution and scheduling

| Concern | Implementation |
|---|---|
| Runner | `src/agents/runner.ts` — crash-safe: any throw closes the run as `error`; a replayed run id returns the stored result |
| Duplicate protection | `src/agents/schedule-lock.ts` over `agent_schedule_lock` (unique `agent_id` + `lock_key`, insert-or-steal, `COMPLETED` terminal, `FAILED` retryable after 60 s, minute-bucket cron slots, optional ops idempotency key) |
| Cron | `src/agents/cron.ts` — 5-field parser, per-agent due check, driven by the single daily Vercel cron or the ops route |
| Rate-limit retry | `src/agents/retry.ts` — `attempts: 3`, `totalWaitMs: 25 000`, honours the provider's `retry-after` |
| Audit | `agent_audit_events` (append-only; a trigger refuses `UPDATE`/`DELETE`) plus `agent_run_events` per tool call |
| Detectors | `src/agents/monitor.ts` — nine pure rules (stuck_run, failed_run, silent_spend, unverified_claim, write_refused, write_without_verify, temporal_mismatch, budget_overrun, repeat_failure) with dedupe keys into `agent_alerts` |
| Tools | `http_fetch` and `delegate_to_agent` only; repo read behind `agents.repo_access`; no shell, no test runner |

**Known defect, unchanged:** the retry budget (25 s across 3 attempts) is shorter than the throttling
window it is trying to outlast (a Groq free-tier TPM window is ~60 s) inside a 60 s function. Three
consecutive scheduled runs died on 429 for exactly this reason. Fixing it is not a bigger sleep — it
is moving the run onto durable execution (Inngest) or rotating across catalogue models so a single
free-tier meter cannot fail the run.

**Second defect, found during this audit:** `src/inngest/functions.ts:34` inserts into `ops_events`,
a table that **does not exist in `schema.sql`** (33 tables, none named that), and the insert is
wrapped in `.catch(() => {})`. A blocked deposit conversion therefore produces no durable record and
no error. That is the same silent-failure shape the monitoring work was built to eliminate, and it
should be fixed in whichever PR first touches Inngest.

---

## 5. Inngest (durable execution)

Installed and wired but almost unused: SDK `4.26.2`, client in `src/inngest/client.ts`, mounted at
`/api/inngest` via `src/routes/inngest.ts`, and a clean `503` (not a crash) when
`INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` are absent. Two functions exist:

- `convert-pending-deposits` — `*/10 * * * *` plus a `thirdeye/deposit.convert` event, concurrency 1, retries 2;
- `team-agent-run` — event `thirdeye/team.run`, concurrency 3.

**Dependency assessment:** keep. It is the only mechanism in the codebase that can express "run this
for longer than 60 seconds and retry it with the same idempotency key", and its free tier
(50 k executions/month, 5 concurrent steps) is two orders of magnitude above current volume. The gap
is coverage, not capability: scheduled agent runs and settlement are still on the Vercel cron path.

Caveat that must be designed for: on Inngest's free plan, exceeding the execution quota **pauses
functions** — it does not bill an overage. A silent pause of `convert-pending-deposits` would look
exactly like a quiet market. Any migration of money-adjacent work onto Inngest needs an independent
liveness check (a `last_success` row compared against `now()`), not just Inngest's own dashboard.

---

## 6. Artifact and file storage

`src/agents/artifacts.ts` stores artifacts **in Postgres**, in `agent_artifacts`: `art_` + 20 hex id,
`content` text, `content_sha256` for dedupe, integer `version`, 200 k character write cap, 40 k
character read cap. It works, it is transactional with the audit trail, and it fixed a real problem
(handoffs degrading into summaries of summaries).

Where it stops being the right home:

- every artifact is a Postgres row and a row rewrite in the same database that holds the ledger;
- there is no lifecycle policy, no compression, no CDN, no signed-URL story for binary content;
- the 200 k cap is a text cap. A PDF, an image, a generated bundle, or a 5 MB research document has
  nowhere to go at all.

There is no object-storage client anywhere in the dependency tree today.

---

## 7. Model provider configuration

`src/providers/{openai,anthropic,mock}.ts` — three adapters: the OpenAI chat-completions protocol with
a per-row `base_url` (so one adapter covers every OpenAI-compatible vendor), Anthropic's native
messages API, and a mock. The catalogue lives in `models_catalog` (12 model ids across 5 vendors +
mock). Platform keys are discovered by convention — `PROV_<NAME>_API_KEY` — and BYOK keys are stored
per user, AES-256-GCM encrypted, with the provider derived from the `base_url` hostname.

**Assessment:** keep exactly as is. Adding a vendor is a catalogue row plus a key, which is the
correct amount of work. The only funding gap is commercial, not structural: only Groq and Mistral are
platform-funded today.

---

## 8. Data sources already in the code

| Source | Where | Notes |
|---|---|---|
| GeckoTerminal | `src/payments/*` price reads | inline, unabstracted |
| Uniswap Trading API | `src/payments/swap.ts` | **quote-only**: returns `0x` with source `uniswap-trading-api:quote-only`, never sends a swap |
| Base / Robinhood / BSC RPC | `src/payments/*`, `src/lib/*` | public endpoints, no provider key |
| GitHub REST | `src/agents/repo-tools.ts` | read-only, gated by `agents.repo_access` |
| Alchemy | env + Gas Manager admin calls | key stored as a platform secret |
| Privy | `src/payments/*` signing | key-quorum authorisation signature |
| Langfuse | `src/telemetry/langfuse.ts` | export awaited behind a 1200 ms bound |

Note the shape: each integration is bespoke, with its own error handling, its own rate-limit story
(or none), and no shared notion of provenance, freshness or cost. **There is no web-research, no
CoinGecko, no DefiLlama, no DEX Screener, no Blockscout and no Graph integration at all.** The
registry in `04` is therefore greenfield, not a refactor.

---

## 9. Monitoring, logging, observability

- **In-app:** `agent_alerts` + `agent_run_events` + `agent_audit_events`; a master-key-gated audit
  route (`POST /api/admin/agents/audit`) and dispatch-to-HERMES path.
- **Public:** `/team` renders a sanitised run ledger (allowlisted columns only, provider errors
  reduced to `rate_limited/timeout/crashed/failed`); `/status` reports the deployed commit.
- **Traces:** Langfuse spans, awaited with a 1200 ms bound so a slow vendor cannot stall a paid run.
- **Platform:** Vercel Web Analytics and Speed Insights are installed on both the SPA and the
  server-rendered shells.
- **Not available:** Vercel runtime logs through the documented REST endpoints on this plan (all 404).
  Measurement therefore has to be built into the app itself — the `/api/stats/public` before/after
  diff is the established technique.

Gap: there is no time-series store, so "was p99 latency worse this week" is answerable only by
querying Postgres tables that were not designed for it.

---

## 10. Financial controls on `main` today

Preserve all of these; they are the reason this platform can hold other people's money.

- Idempotent deposits: `payments` has `UNIQUE (chain_id, tx_hash, token, received_by)`; crediting is
  keyed on that, so a replay cannot double-credit.
- Sender ownership checks and a per-request prepaid balance check (`src/lib/billing.ts`,
  `src/lib/keybudget.ts`, `src/lib/keycredit.ts`).
- Reserve-then-charge on streams with a true-up that runs in a `TransformStream` flush, so a frozen
  serverless context cannot lose the settlement.
- Refund-on-failure for split key/account charges.
- Manual-signature rule for treasury movements (Splits vault, passkeys); no agent-controlled EOA.

**Gap carried forward, stated plainly:** payment finality is *not* on `main`. `payments.status` is
still only `recorded | refused`, and `src/payments/verify.ts` still credits from a single receipt read
with `Number(rawAmount)` at line 230. The per-chain finality policy, explicit state machine
(`detected → confirming → confirmed → credited`, plus `reorged`/`needs_reconciliation`), BigInt units
and append-only `payment_events` all exist only in **PR #41, which is open and unmerged**. Any part of
this brief that touches money must be built on top of #41, not beside it.

---

## 11. Risk register

Ordered by what would hurt first.

| # | Risk | Severity | Why it bites | Owner PR |
|---|---|---|---|---|
| 1 | No versioned migrations; one 603-line idempotent file | High | Every new table in this brief needs it; a partial failure has no record and no rollback | PR-B |
| 2 | Agent runs can outlive the 60 s function; Inngest coverage is 2 functions | High | Runs already fail on a provider meter the retry cannot outlast | PR-H |
| 3 | Retry budget (25 s) < throttle window (~60 s) | High | Chronic 429 failures on the only unattended path | PR-H |
| 4 | Payment finality unmerged (#41) | High | Credit-on-first-read is a reorg loss vector | #41 |
| 5 | Rate limiter is a DB write on the hot path and dies with the DB | Medium | Cost and availability coupling | PR-E |
| 6 | `ops_events` insert targets a non-existent table, error swallowed | Medium | Conversion blockers vanish silently | PR-H |
| 7 | Artifacts in Postgres only; no binary storage | Medium | Blocks document/research ingestion (section 4 of the brief) | PR-F |
| 8 | No pgvector, no FTS, no knowledge reuse | Medium | Agents cannot use anything they learned before | PR-G |
| 9 | PGlite fallback path (if the deploy-time refusal were ever weakened) | Low | Data loss on a config typo — **already refused at boot and 503s**; needs a regression test, not new code | PR-B (test only) |
| 10 | No shared data-provider layer (throttling, provenance, fallback, cost) | Medium | Every integration re-solves it or skips it | PR-C/D |
| 11 | README/cron drift; provider errors only reduced, never trended | Low | Wasted debugging time | PR-A |

---

## 12. What this audit says to keep

Unchanged, and each for a stated reason:

- **Neon Postgres as the ledger.** ACID, one place, already isolated per preview branch. Nothing in
  this brief moves financial state out of it.
- **The dual driver.** It is what makes a zero-dependency local test run possible; the fix is to make
  Postgres *required* in production, not to delete PGlite.
- **The three model adapters and `PROV_<NAME>_API_KEY` convention.** Adding vendors is already free.
- **Inngest.** Wrongly scoped, correctly chosen.
- **`agent_audit_events` + the nine detectors.** This is the most mature part of the system.
- **Single Hono app on Vercel.** A full move to Cloudflare Workers is explicitly out of scope and
  would break the `pg`-based financial paths.
