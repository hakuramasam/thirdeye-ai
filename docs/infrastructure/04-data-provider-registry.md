# 04 — Data provider registry

Goal: one interface for every external data source, so a vendor swap is a config change, and so that
every fact the platform uses carries its source, its age and its cost. Today there is no such layer:
each integration is bespoke and none of them record provenance.

**The rule this document is built around:** free API access is not a commercial licence. A provider can
be integrated and tested, but it cannot serve production traffic until its terms have been read and its
`licence` state is `approved`. The registry enforces that rather than relying on memory.

---

## 1. Capabilities, not vendors

Callers ask for a capability. The registry picks a provider.

```ts
export type Capability =
  // web research
  | 'web.search'        // ranked results for a query
  | 'web.fetch'         // one URL → clean text + metadata
  | 'web.feed'          // RSS/Atom → items
  // blockchain
  | 'chain.logs'        // event logs / transfers
  | 'chain.tx'          // receipt, status, confirmations
  | 'chain.tokens'      // holdings, metadata, decimals
  | 'chain.contracts'   // verified source / ABI
  // market data
  | 'market.quote'      // price + 24h stats for a token
  | 'market.pools'      // DEX pairs, liquidity, volume
  | 'market.candles'    // OHLCV series
  | 'market.overview'   // global / top-N snapshot
  // defi
  | 'defi.protocols'    // protocol list, TVL, chains
  | 'defi.yields'       // pool yields
```

A capability has exactly **one canonical response shape**. That shape is the contract; vendors are
normalised into it and a normaliser that cannot fill a required field returns an error rather than a
zero. Zeros are how bad data becomes a bad decision.

---

## 2. The envelope

Every answer, including every failure, is wrapped:

```ts
export type Provenance = {
  provider: string                 // 'brave' | 'coingecko' | ...
  capability: Capability
  source_url: string               // the exact URL we fetched, query string included
  fetched_at: string               // ISO, our clock
  observed_at: string | null       // ISO, the provider's own timestamp if it gives one
  reliability: 'primary' | 'aggregator' | 'indexer' | 'self_reported'
  confidence: 'observed' | 'derived' | 'inferred'
  freshness_ms: number             // age we accept for this capability
  cost_micros: number              // what this call cost us
  cached: boolean
  licence: 'approved' | 'pending'
}

export type DataResult<T> =
  | { ok: true;  data: T; provenance: Provenance }
  | { ok: false; error: ProviderError }
```

`ProviderError` types, deliberately small so they can be counted:

```ts
export type ProviderErrorType =
  | 'unavailable'      // circuit open / repeated failure
  | 'rate_limited'     // 429, with retry_after_ms when known
  | 'unauthorised'     // bad or missing credential — never retried
  | 'timeout'          // deadline exceeded
  | 'bad_response'     // unparseable / schema violation
  | 'not_found'        // genuine 404 from the vendor
  | 'licence_pending'  // configured but not cleared for production
  | 'refused'          // SSRF guard or size cap refused the request

export type ProviderError = {
  type: ProviderErrorType
  provider: string
  capability: Capability
  retryable: boolean
  detail?: string      // sanitised, never a body dump, never a credential
  attempted: { provider: string; type: ProviderErrorType }[]  // the chain, in order
}
```

`attempted` is the important field: when a price comes back from the third provider in the chain, the
caller can say so, which is what makes a fallback honest instead of invisible.

**Attribution rule.** Because the envelope names the answering provider, no surface may label a figure
with a vendor that did not answer it. A price shown as "CoinGecko" must have `provenance.provider ===
'coingecko'`.

---

## 3. Provider interface

```ts
export type LicenceStatus = 'pending' | 'approved' | 'prohibited'

export interface DataProvider<Req, Res> {
  id: string
  capabilities: Capability[]
  licence: LicenceStatus
  /** Marker for providers that need no credential (RSS, public RPCs, most Blockscout instances). */
  requiresKey: boolean
  /** Published limit we must respect. Enforced by the throttle, not by hope. */
  throttle: { rpm: number; burst: number }
  /** Estimated cost of one call in USD micros; 0 for free tiers. */
  costMicros(req: Req): number
  /** One call. No retries, no cache, no branching to other providers — the registry does that. */
  fetch(req: Req, ctx: ProviderContext): Promise<{ data: Res; observed_at?: string | null }>
  /** Cheap liveness probe used by the circuit breaker and by /api/healthz. */
  probe?(): Promise<boolean>
}

export type ProviderContext = {
  signal: AbortSignal          // deadline propagated from the registry
  deadlineMs: number
  credential: string | null    // resolved server-side, never logged
  now: () => number            // injected, so tests are deterministic
}
```

`fetch` is a single attempt on purpose. Retry, throttle, cache, circuit breaking and fallback live in
one place, so they are implemented once and tested once.

---

## 4. Registry behaviour

### 4.1 Resolution and fallback

```ts
registry.call<Quote>('market.quote', { chain: 'base', address: '0x…' }, {
  deadlineMs: 4000,
  requireFreshMs: 60_000,
  minReliability: 'aggregator',
})
```

Order of operations, per call:

1. **Licence gate.** `licence === 'pending'` in production → skip with `licence_pending`. (`NODE_ENV
   !== 'production'` may use it, so integration and fixtures work before a terms review.)
2. **Cache.** Key = `capability + hash(normalised args)`. Hit only if within `requireFreshMs`. Cache
   hits still return provenance, with `cached: true` and the original `fetched_at` — an age must never
   be reset by a cache read.
3. **Circuit breaker.** Provider with an open circuit is skipped without a network call.
4. **Throttle.** Token bucket. If empty: wait at most 250 ms, then move to the next provider. **Never
   sleep out a full window inside a 60 s function.**
5. **Call** with the remaining deadline, through `transport.ts`.
6. **Validate** against the canonical shape. A schema violation is `bad_response`, not partial data.
7. **Record** `provider_usage`, update `provider_health`, populate the cache, return the envelope.

A chain that ends with no answer returns the aggregate `ProviderError` with every attempt listed.

### 4.2 Throttling

Token bucket per provider, keyed `rl:dp:<provider>:<capability>`, backed by Redis when configured and
by an in-process map otherwise (serverless instances are not shared, so the in-process bucket is a
politeness measure, not a limit — that is stated rather than pretended).

Bucket sizes come from the provider's published limit with a 20% safety margin, because a vendor's
"per minute" and our clock do not have to agree.

### 4.3 Health and circuit breaking

`provider_health` (append-only, one row per probe or per 60 s bucket):

| column | meaning |
|---|---|
| `provider`, `capability` | what was measured |
| `window_start` | bucketed timestamp |
| `ok_count`, `error_count` | outcome counts |
| `p50_ms`, `p95_ms` | latency of the attempts |
| `last_error_type` | one of `ProviderErrorType` |
| `circuit_state` | `closed` / `open` / `half_open` |

Breaker: **5 consecutive failures → open for 60 s → one half-open probe**. State is cached in Redis so
every instance agrees, and falls back to a windowed count from `provider_health` when Redis is absent.
Health also feeds the existing monitor as a new detector (`provider_degraded`), so a dead vendor raises
an alert instead of quietly emptying a table.

### 4.4 Deadlines and retries

- Per provider: `deadlineMs` (default 4 s), enforced with `AbortController`.
- Per call: at most **2 retries**, only on `timeout`, network error or 5xx, with jittered backoff of
  250 ms and 750 ms.
- **Never retried:** `unauthorised` (a bad key does not heal), `bad_response` (a schema mismatch
  repeats), `refused` (an SSRF refusal is a policy decision), `licence_pending`.
- `rate_limited` retries only when `retry_after_ms ≤ 1000`; otherwise it moves to the next provider.
- Overall budget: 8 s. Beyond that the caller gets an error, because a request that spends 30 s
  failing four vendors has already failed its user.

### 4.5 Transport and egress safety

Every outbound call goes through one function that enforces, in this order: URL scheme; no credentials
in the URL; **`src/lib/ssrf.ts` guard** (already shipped, already refuses loopback/link-local/RFC1918/
CGNAT/ULA and pins the socket to the validated address, re-validating each redirect); redirect cap of
2; 2 MiB response cap; 8 s hard timeout; `Content-Type` verification before JSON parse.

This is a hard requirement, not a preference: a provider layer that fetches vendor-supplied URLs
(the Jina reader, RSS feed self-references, Blockscout links) is a server-side request forgery surface
if it does not reuse the existing guard.

### 4.6 Credentials

- **Naming.** Data providers use `DP_<VENDOR>_API_KEY` (`DP_BRAVE_API_KEY`, `DP_TAVILY_API_KEY`,
  `DP_COINGECKO_API_KEY`, …), deliberately distinct from the model convention `PROV_<VENDOR>_API_KEY`
  so a single dump of environment names cannot confuse a model key with a data key.
- **Storage.** Vercel encrypted env for platform keys. User-scoped data keys (a future BYOK) reuse the
  existing AES-256-GCM path in `src/lib/env.ts` (`v1.iv.tag.data`, `MASTER_KEY` with
  `MASTER_KEY_PREVIOUS` rotation) in a `user_provider_keys` table. **No new crypto.**
- **Exposure.** Resolved server-side inside `ProviderContext`. Never returned by an API, never
  included in an error, never written to `agent_run_events` (the existing `scrub()` in
  `src/agents/monitor.ts` already strips key-shaped values and must run over provider errors too).
- **Logging.** A credential is identified by provider and last-4 hint only.

### 4.7 Usage and cost accounting

`provider_usage` (append-only):

```
id, provider, capability, ts, ok, error_type, latency_ms,
cost_micros, cached, request_key_hash, run_id?, agent_id?, user_id?
```

- `cost_micros` comes from `costMicros()` — for free tiers it is `0`, and `0` is recorded explicitly so
  "free" is a measurement rather than an assumption. When a free tier is exhausted and a paid plan
  silently begins, the first non-zero row is the signal.
- A daily rollup answers "what did providers cost us yesterday, per capability" without scanning.
- Provider spend is **operating cost, not user billing**: it must never appear in `ledger`,
  `usage_events` or any user balance. Separate table, separate report, deliberately.

---

## 5. Provider records

Read 14 Nov 2026. `Licence` is the state that gates production use; **`pending` means the terms have
not been read by a human yet, and the registry will refuse it in production regardless of how generous
the free tier is.**

### 5.1 Web research

| Provider | Capabilities | Free tier | Auth | Limits / notes | Licence |
|---|---|---|---|---|---|
| **Brave Search** | `web.search`, `web.fetch` (LLM Context) | **up to $20 of calls per month**, prepaid credits, no subscription | `X-Subscription-Token` header | `api.search.brave.com`; `/res/v1/web/search`, `/res/v1/llm/context`; every source carries URL + timestamp | `pending` — read Brave's API terms; the $20 credit is a credit, not a licence |
| **Tavily** | `web.search`, `web.fetch`, `web.extract` | **1,000 API credits/month**, no card | Bearer key | Credits are consumed per request type (search vs extract vs crawl); PAYG **$0.008/credit**, Project **$30/mo** for 4,000 credits; credits hard-stop when exhausted | `pending` |
| **RSS / Atom** | `web.feed` | n/a — no vendor | none | Self-fetched; must send `If-None-Match`/`If-Modified-Since`, respect 429 and `Retry-After`, cap body at 2 MiB; a publisher's feed is not a licence to republish full text | `approved` for reading; **republishing article bodies is not** |
| **Jina AI** | `web.fetch` | **UNVERIFIED** (not re-read this pass) | key optional on the public reader | `r.jina.ai/<url>` returns LLM-ready markdown; the reader fetches a URL *for* us, so it inherits our SSRF policy question and must only ever be given URLs that already passed `ssrf.ts` | `pending` |

### 5.2 Blockchain

| Provider | Capabilities | Free tier | Auth | Limits / notes | Licence |
|---|---|---|---|---|---|
| **Alchemy** | `chain.logs`, `chain.tx`, `chain.tokens` | existing app "AI Agent"; usage measured **$0.00** this period on Base mainnet JSON-RPC | platform secret `ALCHEMY_API_KEY` | Already used and proven; JSON-RPC `https://<network>.g.alchemy.com/v2/$KEY`; compute-unit metering; mainnet gas sponsorship is closed on the free plan | `pending` — commercial-use clause to confirm before it becomes the sole chain read path |
| **The Graph** | `chain.logs`, `chain.contracts` (subgraph queries) | **UNVERIFIED** — pricing page not retrieved | API key | Query-fee model per subgraph; useful for historical aggregates we do not want to index ourselves | `pending` |
| **Blockscout** | `chain.tx`, `chain.contracts`, `chain.tokens` | public instances are free and largely keyless; **self-hosting is the durable option** | none / optional key | Rate-limited per instance and not an SLA; verified-source and ABI data is its strength; self-host removes the vendor risk | `pending`; self-hosted instance would be `approved` by nature |

### 5.3 Market data

| Provider | Capabilities | Free tier | Auth | Limits / notes | Licence |
|---|---|---|---|---|---|
| **CoinGecko** | `market.quote`, `market.overview` | **UNVERIFIED this pass** — the pricing page returned 403 and the docs URL 404 | `x-cg-demo-api-key` | Historically a Demo tier around 10 k calls/month at ~30 calls/min. **The commercial-use question is the whole decision here**; it must be answered from their terms, in writing, before it backs a paid product | `pending` — treat as `prohibited` for commercial surfaces until confirmed |
| **DEX Screener** | `market.quote`, `market.pools` | free, no key documented | none | Verified limits: **300 req/min** for pairs, search and token-pairs; **60 req/min** for profiles, boosts and orders. Their own "API Terms & Conditions" page exists — read it | `pending` |
| **Binance public market APIs** | `market.candles`, `market.quote` | public endpoints, weight-based limits | none for public | No SLA; explicit terms about commercial redistribution of market data; appropriate for candles, not for a product's headline price | `pending` |
| **GeckoTerminal** *(already in use)* | `market.pools` | free | none | Already the platform's price source for deposits; unabstracted today, and it should be the first provider migrated onto the registry | `approved` (in production use) |

### 5.4 DeFi

| Provider | Capabilities | Free tier | Auth | Limits / notes | Licence |
|---|---|---|---|---|---|
| **DefiLlama** | `defi.protocols`, `defi.yields` | free endpoints and Pro endpoints are documented separately; specific free allowances **UNVERIFIED** | none for free endpoints | Aggregator with its own methodology; a TVL number must carry DefiLlama as the source, not be presented as our measurement | `pending` |

**Verification debt, stated plainly:** four providers (Jina, The Graph, CoinGecko, DefiLlama free
allowances) could not be verified from their own pages during this audit. They are `pending` by
default and the registry will refuse them in production until someone reads the page and flips the
flag. That is the correct outcome, not a gap to paper over.

---

## 6. Fallback chains (proposed)

Fallback is for **reads only**. No write, transfer, signature or credit path may fail over to a second
provider, ever — that is how a retried request becomes a double payment.

| Capability | Order | Rationale |
|---|---|---|
| `web.search` | Brave → Tavily | both carry source URLs and timestamps; the $20 credit makes Brave the free default |
| `web.fetch` | direct fetch → Jina reader → Brave LLM Context | cheapest and most faithful first; the reader only when the page is JS-rendered |
| `web.feed` | direct RSS → (no fallback) | a feed that is down is down; inventing items is worse than an empty list |
| `market.quote` (token, Base) | GeckoTerminal (in use) → DEX Screener → CoinGecko | the pool we actually trade against is the most relevant source, not the most famous |
| `market.overview` | CoinGecko → DefiLlama | only after the CoinGecko licence question is settled |
| `market.candles` | Binance → DEX Screener | depth and history vs on-chain truth |
| `chain.tx` / `chain.logs` | Alchemy → Blockscout → public RPC | Alchemy first because it is keyed and measured; public RPC last because it is unauthenticated and unaudited |
| `chain.contracts` | Blockscout → Sourcify-style verified source → The Graph | verified source is the only source of truth for an ABI |
| `defi.protocols` | DefiLlama → (no fallback) | one aggregator with a documented methodology; a second one with different numbers would be worse than none |

The **payment verification path keeps its current, deliberate shape**: it reads the chain, and a
fallback there must produce an identical answer or the payment goes to `needs_reconciliation`. This
document does not change it.

---

## 7. Recorded in the audit trail

Each recorded agent run that touches a provider gains rows in the existing `agent_run_events`
(one per provider *call*, not per retry), with:

- capability, provider, `ok`, error type, latency, cost micros, cached;
- the `source_url` **without** query-string secrets (strip `api_key`, `apikey`, `token`, `key`);
- `fetched_at` and `observed_at`.

This is what makes an agent's claim checkable after the fact: "the price is $0.42" is traceable to a
URL, a timestamp and a provider, and the run can be re-judged later without re-calling the vendor.

---

## 8. Tests this design implies

| Test | What it proves |
|---|---|
| Contract tests, one per provider, against a recorded fixture | the normaliser produces the canonical shape, and a missing field errors instead of defaulting to 0 |
| Throttle test with an injected clock | the bucket never exceeds `rpm`, and an empty bucket moves on instead of sleeping |
| Retry test: 429 with `retry-after: 30` | it does **not** wait 30 s inside the function; it falls through |
| Deadline test: a vendor that never answers | the call returns `timeout` within budget |
| Licence test: `licence: 'pending'` under `NODE_ENV=production` | the call returns `licence_pending` and no network request is made |
| SSRF test: a provider returning `http://169.254.169.254/…` as a feed URL | refused by `ssrf.ts`, surfaced as `refused` |
| Fallback test: provider 1 returns 500 | provider 2 answers and `attempted` lists provider 1 |
| Provenance test | `source_url`, `fetched_at` and `provider` survive the fallback and the cache |
| Cache test | a cache hit preserves the original `fetched_at` and sets `cached: true` |
| Accounting test | every call writes exactly one `provider_usage` row, with `0` for a free tier |
| No-network test | the whole suite runs with outbound HTTP disabled and still passes |

That last one matters most: it is the difference between a registry that is tested and a registry that
is merely exercised.
