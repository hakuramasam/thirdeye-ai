# Infrastructure expansion and data provider plan

Planning pack for scaling Thirdeye AI on free-tier and open-source-friendly infrastructure without
moving the financial ledger off Neon or changing any component that already works.

**Status of this pack: proposal only.** No code, schema, config or dependency changes. The audit
describes `main` at `4723be0` as measured on 14 Nov 2026; everything after `01` is a plan awaiting
approval.

---

## Reading order

| File | Answers |
|---|---|
| [`01-existing-audit.md`](01-existing-audit.md) | What runs today, file by file, and what breaks first |
| [`02-provider-matrix.md`](02-provider-matrix.md) | Free tiers, limits, suitability, env vars, security, fallback, cost at 1×/10×/100× |
| [`03-target-architecture.md`](03-target-architecture.md) | The target shape, new modules, dependency assessment, failure map |
| [`04-data-provider-registry.md`](04-data-provider-registry.md) | Capability interfaces, provenance, throttling, health, fallback, per-vendor records and licence gates |
| [`05-data-intelligence.md`](05-data-intelligence.md) | Ingestion, chunking, pgvector, hybrid search, dedupe, retention, agent knowledge reuse |
| [`06-migration-plan.md`](06-migration-plan.md) | Nine PRs, in order, each with scope, tests, rollout, rollback |
| [`07-security-and-testing.md`](07-security-and-testing.md) | What is authoritative, the threat table, the failure-injection matrix, PR rules |

---

## The short version

1. **Nothing that works gets replaced.** Neon stays the ledger. Vercel stays the runtime. The three
   model adapters stay. Inngest stays, with more coverage. No Cloudflare Workers migration.
2. **The real blockers are not vendors.** They are: no versioned migrations, scheduled runs that die
   inside a 60 s function, a retry budget shorter than the throttle window it is racing, and no shared
   provider layer at all. Three of those four are bugs, not architecture.
3. **The whole plan is free at current volume**, and stays under $1/month at 10×. The first genuine
   cliff is Inngest's execution quota at roughly 20,000 multi-step runs/month, and it *pauses* rather
   than billing.
4. **Free is not a licence.** Four of the eleven data providers could not be verified from their own
   published terms during this pass. The registry refuses `licence: 'pending'` in production, so the
   default state of an unreviewed vendor is "cannot serve traffic", not "probably fine".

---

## What is implemented, tested, deployed, proposed

| Item | Implemented | Tested | Deployed | Note |
|---|---|---|---|---|
| This planning pack | ✅ (this PR) | n/a — docs | ❌ | Proposal only |
| Existing infra audit | ✅ | n/a | n/a | Reflects `main` `4723be0` |
| Versioned migrations | ❌ | ❌ | ❌ | PR-B |
| Provider registry core | ❌ | ❌ | ❌ | PR-C |
| Market/chain providers on the registry | ❌ | ❌ | ❌ | PR-D1 |
| Web research providers | ❌ | ❌ | ❌ | PR-D2, gated on terms review |
| Upstash Redis limiter | ❌ | ❌ | ❌ | PR-E, shadow first |
| R2 blob storage | ❌ | ❌ | ❌ | PR-F |
| Knowledge engine (keyword) | ❌ | ❌ | ❌ | PR-G1 |
| pgvector hybrid retrieval | ❌ | ❌ | ❌ | PR-G2, gated on the embedding decision |
| Durable scheduled runs + model rotation | ❌ | ❌ | ❌ | PR-H |
| Cloudflare edge probe | ❌ | ❌ | ❌ | PR-I, optional |
| Payment finality (per-chain confirmations, state machine) | ✅ code, **unmerged** | ✅ 402/402 on the branch | ❌ | **PR #41** — must land before anything touches money |

The last row is the one to read twice: the financial controls this plan promises to preserve are
themselves waiting on an unmerged PR.

---

## Decisions needed from Sam

1. **Sequencing.** Approve PR-B then PR-C, or ask for a different order. Everything else waits on those
   two.
2. **The embedding provider** (`02` §5, `05` §8). Recommendation: ship keyword retrieval first, decide
   later, because the schema accepts vectors either way.
3. **Terms review for four providers** (Jina, The Graph, CoinGecko, DefiLlama). Someone has to read the
   pages; the registry will refuse them until then, which is the intended behaviour.
4. **Whether archived agent artifacts may live in R2** (`02` §5.3) — a data-residency question, not a
   technical one.
5. **PR #41.** Payment finality is the one piece of this platform that must not be planned around; it
   should be merged or explicitly parked before PR-D1 goes near pricing.
