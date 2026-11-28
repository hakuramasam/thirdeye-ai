# Staging HERMES Dispatch — Guardrail Design

Status: proposal only. This document does not enable dispatch, create credentials, invoke agents, or change runtime configuration.

## Approved pilot envelope

- Target repository: `hakuramasam/thirdeye-ai`
- Immutable review revision: `dd956e60524020d1e8218bd1652d1cab356d2414`
- Root agent: `tdt_hermes` (HERMES)
- Permitted delegated roles: `tdt_qa` (QA) and `tdt_sentinel` (SENTINEL) only
- Aggregate maximum spend: **67,000 USD micros ($0.067)** across the root and all descendants
- Environment: isolated Vercel Preview/staging only
- Production, merge, deployment, provider changes, and standing permission changes: prohibited

## Security invariants (fail closed)

1. A dedicated `STAGING_DISPATCH_SECRET` is distinct from `CRON_SECRET`. It is provisioned only in the isolated Preview environment by the owner. Never reuse, read, print, or transmit the production cron credential.
2. The route refuses requests unless `VERCEL_ENV === 'preview'` and the deployed commit is an explicitly approved staging build. Missing environment metadata is a refusal.
3. The request must contain the exact immutable target SHA above. Branch names and mutable refs are not accepted as review targets.
4. The authenticated caller can start only HERMES. The server resolves HERMES by its canonical ID and ignores caller-supplied agent IDs, owner IDs, models, prompts, and budgets.
5. HERMES delegation is constrained server-side to the canonical QA and SENTINEL IDs. All other recipients, nested delegation beyond those two reviewers, cron scheduling, general-purpose tools, repository writes, deployments, and arbitrary HTTP/MCP tools are refused for this dispatch.
6. The aggregate budget is one shared ledger/reservation of 67,000 micros for the entire root/child tree, not three independent per-run budgets. Each provider call must reserve its maximum charge before execution; settlement records actual charge. On reservation failure or cap exhaustion, stop the entire tree. Concurrent children must use an atomic database operation/transaction to prevent overspend.
7. No x402, wallet, treasury, chain transaction, paid external tool, or arbitrary outbound URL is available in this pilot.
8. Dispatch is one-shot and idempotent. A unique owner-approved dispatch ID binds the target SHA, roles, budget, and authorization; replay returns the prior result and never launches a second tree.
9. Audit every authorization decision, refusal, delegation, reservation, settlement, artifact, and completion with a common correlation ID. Never log credentials, prompts containing secrets, or raw customer contact details.
10. The endpoint remains disabled until independent QA and SENTINEL approve its implementation and tests. A PR merge or preview deployment alone does not enable it.

## Proposed request contract

`POST /api/ops/staging/hermes-review`

Headers:
- `Authorization: Bearer <STAGING_DISPATCH_SECRET>`

Body (strict schema; reject unknown keys):
```json
{
  "dispatch_id": "owner-issued-one-time-id",
  "target_sha": "dd956e60524020d1e8218bd1652d1cab356d2414"
}
```

The server derives all other values from the immutable policy above. Do not accept an agent ID, budget, role list, model, prompt, repository URL, branch, pipeline, or tool list from the caller.

## Required implementation work

- Add a dedicated route module; do not extend or reuse `/api/cron/agents`.
- Add a typed staging secret field that is optional at boot but required by this route.
- Enforce Preview-only execution and commit-SHA pinning before database access or dispatch.
- Implement a database-backed dispatch ledger and atomic aggregate budget reservation/settlement. Define idempotency and concurrent child behavior.
- Add a run-scoped delegation policy to the runner/tool executor. Do not mutate persisted agent permissions or globally widen HERMES.
- Scope QA and SENTINEL to read-only access to the fixed PR diff, relevant repository files, and generated review artifacts.
- Store separate QA and SENTINEL reports as durable artifacts; HERMES may summarize but may not alter their source reports.
- Keep the route disabled by default. A separate explicit owner enablement action is required after preview deployment and independent security approval.

## Test-first acceptance matrix

1. 401 for missing/wrong staging credential; production `CRON_SECRET` never authenticates this route.
2. Refuse `VERCEL_ENV=production`, development, missing environment, and mismatched deployment SHA.
3. Refuse any target SHA other than the pinned SHA; refuse mutable branch/ref input and unknown body keys.
4. Only HERMES can be the root. QA/SENTINEL cannot become roots; all other agent IDs are refused.
5. HERMES can delegate to QA and SENTINEL; attempts to delegate to any other ID or a second-generation child are refused and audited.
6. QA and SENTINEL cannot write repository files, access secrets, use wallet/x402 tools, or call arbitrary URLs.
7. Aggregate reservations across root and children never exceed 67,000 micros, including concurrent reservations, retries, failed runs, and duplicate dispatch requests.
8. A failed settlement, database error, unknown charge, or missing ledger state fails closed and stops subsequent model calls.
9. Duplicate dispatch ID is idempotent and does not incur duplicate spend.
10. A successful run yields one durable task, a HERMES root run, distinct QA and SENTINEL child runs, separate immutable review artifacts, and an audit trail proving common target SHA and correlation ID.
11. Tests use fake providers and zero-cost fixtures. No live provider call or paid test is required to prove the guardrails.
12. CI, independent QA, and independent SENTINEL review must pass on the exact same feature-branch head before any owner considers enabling Preview dispatch.

## Rollout gates

- Gate A — implementation + failing tests first; no secret, no dispatch.
- Gate B — CI green and independent QA/SENTINEL review of the same SHA.
- Gate C — owner provisions a new Preview-only secret and enables the route; secret value stays in Vercel and is never exposed to the agent/chat.
- Gate D — one owner-triggered non-production dispatch; verify spend ledger, exact SHA, task, two child runs, artifacts, and audit trail.
- Gate E — owner reviews evidence. No production rollout is included in this proposal.

## Current limitations

This PR is a design/contract proposal only. It does not create Vercel environment variables, provision credentials, change Neon schema, implement a dispatch endpoint, or start any agent run. Those require separate reviewed implementation and owner-controlled Preview configuration.
