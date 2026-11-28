# Thirdeye AI product truth audit — 2026-11-28

## Scope and evidence

This is a point-in-time engineering/product audit, not a penetration test or a claim that every customer journey was executed.

- Repository baseline: `main` at `8ceee5a025ed96b163a7aa6c1d63b29e49a8cea1` (2026-11-28).
- Production Vercel deployment observed: `190fd6632450c86edca305e4e6f2b0d3b42879ba`, READY, deployed 2026-11-26. This is behind the reviewed `main` baseline.
- GitHub CI run #541 on the baseline: typecheck, agent-platform validation, PGlite suite and credential scan succeeded; 516 tests passed.
- GitHub's Vercel status check on the current main SHA reports `Account is blocked`; the latest READY deployment therefore does not prove that current main is live.
- Production Neon evidence below was gathered with read-only SQL on 2026-11-28. No production data was changed.
- The public site could not be fetched by the review web reader. Public-page statements were checked against `src/routes/public.ts`; no signed-in browser, wallet, live inference charge or live deposit was executed.

## Customer journey: implementation versus proof

| Customer action | Current implementation | Assessment |
|---|---|---|
| Discover the platform and docs | Public `/platform`, `/docs`, `/roadmap`, `/status`, `/agents`, `/team`, `/changelog` routes | Implemented in source. Public copy and changelog had stale claims; this PR syncs them. |
| Sign in with a wallet | SIWE, injected-wallet discovery and WalletConnect in the dashboard | Implemented. A live wallet sign-in was not performed in this audit. |
| Create and manage API keys | Session-authenticated key CRUD, SHA-256 key hashes, per-key RPM/TPM and monthly budget | Implemented in source and covered by tests. |
| Discover models | `GET /api/v1/models` uses `apiKeyAuth()` | API-key required. The public API guide incorrectly said this endpoint was unauthenticated; corrected in this PR. |
| Call inference | OpenAI-compatible chat completions, streaming, tool calls, usage accounting and cost headers | Implemented. End-to-end paid inference with a customer key was not performed in this audit. |
| Use BYOK | Provider keys encrypted with AES-256-GCM and decrypted for that user's call | Implemented in source. |
| Use platform-brokered provider keys | A configured provider key is selected for the resolved provider | Implemented, but **not** a multi-key pool or automatic provider failover. The old public claim of a live provider pool/fallback chain was overstated and is corrected. |
| Add credits | Deposit intent and verification routes; Base USDC, BNB Smart Chain USDT/USDC, Robinhood Chain USDG, plus optional/runtime-registered non-stable assets including THIRDEYE | Verification and credit paths exist. Supported assets are shown by the authenticated deposit-info endpoint. A live deposit was not attempted. |
| Trust deposit finality | Receipt status and matching transfer logs are checked | **Incomplete:** current verification does not enforce a confirmation-depth/finality policy or explicit reorg recovery. This remains a financial P0 before scaling deposits. |
| Create and run personal agents | Agent CRUD, manual run, run history, cron, step and spend limits | Implemented in source. Fine-grained schedules need an external pinger; Vercel's configured cron is daily at 09:00 UTC. |
| Attach MCP tools | Agent configuration accepts MCP server URLs and optional headers; destination policy is enforced | Partially implemented. There is no dedicated encrypted MCP credential vault. Do not put long-lived bearer credentials in MCP headers until that exists. |
| Use x402 tools | Per-agent enable flag, seller allowlist, per-call cap and public-destination checks | Implemented in source. Not enabled by default. |
| Register an external agent identity | Agent registration, own key, directory and A2A card/endpoint | Implemented in source and documented. |
| Monitor customer usage | Per-user usage and billing data routes/dashboard | Implemented in source. No end-to-end customer journey was run in this review. |
| Operate the platform as an administrator | Master-key admin endpoints exist for agent credit and payment operations | API surface exists; a complete cross-customer admin console and model-pricing editor do not. |
| See team engineering work | Public `/team` page reads agent runs and tool events | Implemented as a read-only activity view, not a durable task board or proof of autonomous delivery. |

## Claims corrected by this synchronization

1. **Provider pool/fallback:** `src/providers/index.ts` resolves a model to one provider and chooses that user's BYOK key or the configured platform provider key. There is no multi-key provider pool or automatic fallback chain in this code path.
2. **Model list authentication:** `src/routes/v1.ts` wraps `GET /api/v1/models` in `apiKeyAuth()`. A bearer API key is required.
3. **Platform token:** THIRDEYE was launched on Base on 2026-11-12 with a fixed 1,000,000,000 supply. The code has a runtime token registry and policy-price deposit path. Actual production activation still depends on environment configuration; this audit does not claim that a live THIRDEYE deposit was verified.
4. **Audit and artifacts:** correlation-aware audit events and addressable artifacts exist. Their presence does not mean the pipeline system is actively processing production tasks.
5. **Agent pipelines:** stage-planning/enforcement code exists, but production records show no pipeline or stage IDs in the last 30 days. See the agent-team audit.
6. **Public pages and agent API:** these are already implemented; they should not remain marked as merely in progress.

## Release and reliability status

- Current main SHA: `8ceee5a`; latest verified production deployment SHA: `190fd66` (2026-11-26).
- The GitHub Vercel status check reports `Account is blocked`. Resolve the Vercel account/deployment block before calling the latest main release live.
- Vercel runtime diagnostics over the observed seven-day window reported 2,846 repetitions of the PostgreSQL SSL-mode compatibility warning across 41 users, plus one application-initialization timeout. The SSL warning is not itself proof of a failed request, but it should be cleaned up before the pg/pg-connection-string major upgrade.
- Main CI run #541 passed 516 tests. The standard CI suite uses PGlite; it is not a substitute for real PostgreSQL integration coverage.
- PR #122 adds Testcontainers PostgreSQL coverage. Its first integration attempt failed before tests loaded because Testcontainers 12.2.2 requires Node >=22.22 while the integration job used Node 20. The branch now switches only the integration job to Node 22. Run #544 passed both jobs: 516 PGlite verification tests and all 3 PostgreSQL integration tests. The PR remains open and unmerged, so the coverage is not yet part of main. The Testcontainers Cloud action was skipped on the PR event by design; these tests ran on the GitHub-hosted Docker engine.
- Current CI does not run a dedicated browser-based customer journey or a production-like wallet/payment E2E test.

## Prioritized product backlog

### P0 — trust, money and release correctness

- Implement and test chain-specific confirmation depth, finality, reorg detection and safe reconciliation before treating a deposit as final.
- Unblock Vercel deployment and promote a reviewed commit; verify the deployed SHA equals the intended main SHA.
- Add a safe end-to-end smoke path: wallet sign-in → API key → model list → mock inference → usage/ledger check. Keep live paid provider calls and on-chain deposits separately gated.
- Keep public API authentication instructions aligned with middleware; the model catalogue is API-key protected.

### P1 — customer usability and operations

- Add provider health/failover and multi-key pooling only after explicit routing, retry and budget semantics are designed; do not market them as existing.
- Add a dedicated encrypted secret store for MCP headers/credentials.
- Add a usable admin console for cross-customer support, model pricing and reconciliation; retain master-key API protections.
- Add customer balance alerts, prepaid credit packs, invoices/receipts and clear deposit-finality status.
- Add durable task records, resumable execution and a visible task board for the development-agent system.
- Prove each wallet, credit, key and inference workflow with browser/API integration tests.

### P2 — expansion

- Tokenized platform metrics: the public stats feed is plumbing, not the tokenization product.
- Custom subdomains. The apex custom domain is configured; DNS verification for secondary subdomains is still a dependency. PR #120 proposes path-based surfaces and remains separate from production deployment.
- Broader provider catalog, provider-specific quotas and per-provider spend controls.

## Acceptance rule

A feature is **shipped** only when source, tests and a deployable build support it. It is **live** only when the production deployment includes the commit and the production configuration is present. It is **proven** only when an end-to-end test or production evidence demonstrates the customer action. Do not collapse these three states.
