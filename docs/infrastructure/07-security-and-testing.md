# 07 — Security and testing plan

Two questions: what must never break, and how we would know if it did.

---

## 1. What is authoritative, and what is not

Written down once so no future PR has to guess.

| Fact | Authority | Never cached in | Never derived from |
|---|---|---|---|
| User credit balance | `ledger` (signed sum) / `credit_allowances` — Postgres | Redis, memory, a cookie | a client value |
| Deposit state | `deposits` + `payments` — Postgres | Redis, an Inngest payload | a cached chain read |
| Payment finality | the chain read at verification time + `confirmations` policy | — | a cached receipt |
| Usage and billing | `usage_events`, `ledger` | Redis | a header |
| API key validity | `api_keys` (SHA-256 hash at rest) | Redis (a *positive* cache only, with a short TTL and revocation invalidation) | a JWT claim alone |
| Rate-limit counters | `ratelimit_counters` (Postgres), Redis as a fast path | — | client-supplied counters |
| Provider data | the provider's response + `provenance` | Redis with a TTL **shorter than the freshness policy** | arithmetic on an older response |
| Artifacts / documents | `agent_artifacts`, `documents` (Postgres index) + R2 blob | — | an object key alone (a key without a row is not a fact) |

Renaming this table is the fastest way to lose money. `02` §2.4 and `03` §5 both defer to it.

---

## 2. Non-negotiables, each with the mechanism that enforces it

| Requirement (from the brief) | Mechanism |
|---|---|
| **Never store financial balances as Redis values** | Redis keys are namespaced `rl:` (rate limit) and `px:` (provider cache) only. No module other than `src/lib/cache.ts` may write to Redis, and `cache.ts` refuses keys whose value shape carries a balance. A test asserts no `ledger`/`deposits`/`payments` read path imports the cache |
| **Neon is the authoritative financial ledger** | Single writer: `src/db/index.ts`. `provider_usage` and `provider_health` are deliberately *separate* from `ledger` so operating cost can never be mistaken for a user movement |
| **Preserve idempotent deposit processing** | `UNIQUE (chain_id, tx_hash, token, received_by)` plus the confirm-then-credit idempotency in PR #41. No new code path may insert a credit without going through the same key |
| **Preserve payment finality and reconciliation** | PR #41 is the reference. Nothing in this plan alters `src/payments/*`; **PR-D1 must not make a price provider the decider of whether a deposit credits** |
| **Encrypt external API credentials** | Existing AES-256-GCM (`v1.iv.tag.data`) with `MASTER_KEY` / `MASTER_KEY_PREVIOUS`; platform keys in Vercel encrypted env. No new cipher, no key in the repo |
| **Never expose provider credentials to frontend clients** | Credentials are resolved inside `ProviderContext`, server-side only; no `VITE_*` variable may hold one; an error body never contains one; a test greps the built web bundle for `DP_` / `PROV_` / `sk-` shapes |
| **Provider failover cannot duplicate financial actions** | Failover exists only for capability reads. No retry, fallback or breaker applies to send/sign/credit. Each write path keeps its own idempotency key, and a retried write returns the stored result rather than acting twice |
| **No automatic transactions beyond existing policies** | Treasury stays passkey/manual; `x402` stays capped (20000 µ$ per call default); agents still have no signer |

---

## 3. New attack surface, and the control for each

| # | Threat | Where it appears | Control |
|---|---|---|---|
| 1 | **SSRF** via provider-supplied URLs (feeds, redirects, "fetch this page" tools) | `src/data/transport.ts`, Jina reader, RSS self-links | Every outbound URL passes the existing `src/lib/ssrf.ts` guard: scheme allowlist, no URL credentials, low ports refused, loopback/link-local/CGNAT/RFC1918/ULA refused including IPv4-mapped IPv6, socket pinned to the validated address, each redirect hop re-validated |
| 2 | **Credential exfiltration through logs/artifacts/errors** | `agent_run_events`, `provider_usage`, error bodies, artifacts | `scrub()` runs over provider errors before storage; only provider + last-4 hint is recorded; a test asserts a planted key never appears in a stored event, an artifact or a public page |
| 3 | **Prompt injection via retrieved content** | `knowledge_search` passages, `http_fetch` results | Retrieved text is data: it cannot add tools, raise budgets, change policy or authorise writes. Citations are required for claims. The rule is enforced by the runner's tool policy, not by the model's goodwill |
| 4 | **Cache poisoning** | `src/lib/cache.ts`, provider cache | Keys are built from capability + normalised args only, never from client-supplied strings; values are schema-validated on write *and* on read; TTL bounded by the capability's freshness policy |
| 5 | **Cache as a confused deputy** | shared Redis across tenants | Namespaced prefixes; no user-controlled key segments; a collision test |
| 6 | **IDOR on blobs** | R2 presigned GETs | Keys are content-hash based and not user-guessable; `signGet` checks the artifact row's `user_id` before signing; TTL ≤ 300 s; no public bucket |
| 7 | **Forged workflow events** | `/api/inngest` | Signature verification via `INNGEST_SIGNING_KEY`; unsigned requests already return 401 and that behaviour is pinned by a test |
| 8 | **Cost abuse** (someone makes us call a paid provider in a loop) | any provider-backed route | Per-key rate limits, per-capability daily budget in `provider_usage`, a hard ceiling that returns `provider_budget_exhausted` rather than spending, and no provider call from an unauthenticated route |
| 9 | **Supply chain** | `aws4fetch` (the only new dep) | Pinned version, MIT, ~5 kB, no transitive deps; reviewed at the PR that adds it |
| 10 | **Re-publication / licence breach** | any surface that shows third-party data | `licence: 'pending'` is refused in production by the registry; attribution comes from `provenance.provider`; raw vendor payloads are not stored beyond what the response needs |
| 11 | **PII in the knowledge corpus** | ingestion | `documents.user_id` scopes private content; retention TTL; no embedding of anything marked private; the platform corpus is public-source only |
| 12 | **Silent degradation** (the theme of this codebase) | every new component | Circuit breaker + `provider_health` + a `provider_degraded` monitor detector + the Inngest `last_success` heartbeat. A component that stops is louder than one that errors |

---

## 4. Why the payment path is fenced off in this plan

`main` still credits a deposit from a single receipt read (`src/payments/verify.ts`, `Number()` at line
230, `payments.status ∈ {recorded, refused}`). The explicit state machine with per-chain finality,
`confirmations`, `observed_block`, `credited_at` and the append-only `payment_events` audit exists only
in **PR #41, unmerged**.

Two consequences the implementers must respect:

1. **Nothing in phases 2–5 may add a second path that reaches a credit.** The registry is read-only;
   the knowledge engine is read-only; a blob store has no ledger access. If a future PR needs to price
   or verify a deposit, it goes through `src/payments/*` and therefore inherits #41's guarantees or
   blocks on it.
2. **Failover must not exist on the verification path.** If provider A says "confirmed" and provider B
   says "not found", there is no reconciliation that makes that safe — the answer is
   `needs_reconciliation`, never "try the other one". This is the clearest example of the brief's
   "provider failover cannot duplicate financial actions" and it belongs in the code as a comment and
   in the tests as a refusal.

---

## 5. Secrets handling checklist (every PR)

- [ ] New variable documented in `.env.example` with a comment, and named per convention
      (`DP_*` for data providers, `PROV_*` for model providers, `R2_*`, `UPSTASH_*`, `KNOWLEDGE_*`).
- [ ] No value in the repo, in a test fixture, in a doc example, or in a commit message.
- [ ] Not readable by the browser: no `VITE_` prefix, no value echoed by an API.
- [ ] Error paths sanitised: no upstream body, no URL with a query-string key (strip
      `api_key|apikey|token|key|secret`).
- [ ] Rotation story stated (AES-GCM `MASTER_KEY_PREVIOUS` for stored keys; Vercel env rotation for
      platform keys).
- [ ] If the variable is required in production, it fails **closed** with a named problem, in the
      existing `config-guard` style — never a silent default.

---

## 6. Testing plan

### 6.1 Layers

| Layer | What it covers | Runs in |
|---|---|---|
| Unit | throttle maths, chunker boundaries, normalisers, `retryDelayMs`, breaker transitions | `npm test` (PGlite, no network) |
| Contract | one recorded fixture per provider, asserting the canonical shape and that a missing required field errors | `npm test` |
| Integration | registry end-to-end against a fake transport; search against a seeded corpus; migration runner against a fresh database | `npm test` |
| Migration | fresh → all versions; twice → idempotent; edited applied file → refuse; mid-file failure → no row | `npm test` |
| Security | SSRF refusals through the provider transport; key-leak scans; injection fixture stored but not obeyed | `npm test` |
| Regression | the existing 41 test files plus the HTTP end-to-end script (392 passing at `4723be0`) stay green | `verify` |
| Live | `/api/healthz` measured database, one row read back, `/team` renders | after deploy, recorded in the PR |

### 6.2 Harness additions

- **Fake clock** injected into `ProviderContext` (`now()`), so bucket and TTL behaviour is deterministic
  without sleeping.
- **Fake transport**: a `fetch` seam so no test can reach the network. A test asserts `globalThis.fetch`
  was never called with a non-fixture host during the suite.
- **Fixture recorder**: one script that captures a real response to `tests/fixtures/<provider>/<case>.json`
  (redacted), run manually, committed. Fixtures are evidence, not live calls.
- **PGlite vector extension**: registered in the test harness when available; the suite must also pass
  with it *absent*, proving the keyword fallback.
- **Ledger guards**: extend the existing `scripts/balance-sweep.mjs` idea with a test that asserts no
  financial table is touched by the cache, provider or knowledge modules (a light import-graph check is
  enough and catches the mistake early).

### 6.3 Failure injection matrix

Every new component must survive this table in a test, not in a hope.

| Injected failure | Expected behaviour |
|---|---|
| Provider returns 500 twice, then 200 | retries honour the cap, then succeeds; `provider_usage` records 3 attempts, 1 success |
| Provider returns 429 with `retry-after: 30` | no wait; next provider in the chain; `attempted[]` lists the first |
| Provider returns 401 | `unauthorised`, **no retry**, breaker counts it, alert at threshold |
| Provider never responds | `timeout` inside the deadline; the request budget is respected |
| Provider returns 3 MiB | refused at the cap, `refused`, nothing buffered further |
| Provider returns valid JSON of the wrong shape | `bad_response`, no partial object |
| Redis down | Postgres limiter answers inside budget; no correctness change |
| Redis returns a wrong-typed value | treated as a miss, not as data |
| R2 down on write | row written, `storage_key` null, retry queued |
| R2 returns an object whose hash mismatches | refusal and `needs_reconciliation`-style error, never the wrong bytes |
| Inngest quota exhausted | functions pause; heartbeat detector raises HIGH within one interval |
| Vector extension missing | keyword search, `retrieval: 'keyword'`, no exception |
| Embedder unavailable | chunks stored with `embedding` null, ingestion reports partial, backfill later |
| Licence `pending` in production | `licence_pending`, **zero network calls** |

### 6.4 Rules for a PR to be mergeable

1. `verify` green (typecheck + the full suite), all review threads resolved.
2. New behaviour covered by a test that would **fail without the change** — a test that passes either
   way is documentation, not a test.
3. Every claim in the PR body is a measurement with the command or the response that produced it.
   No "should work", no "tests pass" without the count.
4. No secret in the diff, in a fixture, or in a log line.
5. Schema changes: new migration file, tested on a Neon branch, index cost noted.
6. Rollback stated: which flag, which revert, what stays behind.
7. Docs updated in the same PR (`docs/infrastructure/*`, `.env.example`).

### 6.5 What "verified" means after deploy

A PR is not done when CI is green. The check is:

- `/api/healthz` reports `{ ok: true, database: { ok: true } }`;
- one row the PR claims to write is read back from production (by id, not by count);
- the public surfaces still render (`/status`, `/team`, `/docs`);
- for anything flagged, the flag is set deliberately and recorded in the PR body;
- **what remains merely proposed is listed as proposed.** Merged is not deployed, deployed is not
  verified, and verified is not the same as a guarantee about the future.
