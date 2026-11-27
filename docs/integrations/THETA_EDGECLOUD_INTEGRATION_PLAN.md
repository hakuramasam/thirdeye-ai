# Theta EdgeCloud Integration — Design and Test Plan

**Status:** design/repository inspection only. No Theta credentials have been requested, read, stored, or used. No network calls have been made to authenticated Theta APIs. No GPU node has been created. No deployment or production configuration change has occurred.
**Branch:** `feature/theta-edgecloud-integration-plan`
**Base revision:** `190fd6632450c86edca305e4e6f2b0d3b42879ba`
**Requested initial test spend ceiling:** USD 1.00 (1,000,000 USD micros), application-side aggregate ceiling. This is a requested future limit, not spend authorization for this design phase.
**GPU scope:** design for GPU discovery and lifecycle integration; GPU write operations remain disabled until a separate explicit approval.

## 1. Repository inspection

Inspected the current `main` branch at `190fd6632450c86edca305e4e6f2b0d3b42879ba`.

Relevant existing architecture:

- TypeScript ESM, Node.js >=20, Hono API, Vite/React dashboard.
- `src/providers/index.ts` resolves provider credentials from server-side environment configuration and provides an OpenAI-style `ProviderCall` abstraction with non-streaming and streaming methods.
- `src/routes/v1.ts` is the OpenAI-compatible inference API surface.
- `models_catalog` stores provider, upstream model, base URL and token prices.
- `src/lib/env.ts` centralizes environment configuration; `.env.example` documents provider keys.
- `src/agents/mcp.ts` connects to user-configured Streamable HTTP MCP servers and exposes their tools in OpenAI function-call format. It currently has URL/SSRF checks but does not implement Theta-specific per-tool approval, GPU lifecycle policy, or spend accounting.
- `src/agents/runner.ts` can execute MCP tools, delegated tasks, multi-step model calls, and records run spend.
- `src/db/schema.sql` has usage events, agent run spend, and user ledger, but no Theta project, GPU node, reservation, or provider-specific spend ledger.
- `vercel.json` rewrites API routes to one serverless function and defines a daily agent cron. No Vercel settings are to be changed as part of this work.

## 2. Theta EdgeCloud capabilities and documented interfaces

Official Theta documentation reviewed:

- EdgeCloud overview: https://docs.thetatoken.org/docs/theta-edgecloud-overview
- On-demand model inference: https://docs.thetatoken.org/docs/edgecloud-on-demand-model-apis
- Hosted MCP server: https://docs.thetatoken.org/docs/theta-edgecloud-mcp-server
- API keys: https://docs.thetatoken.org/docs/edgecloud-api-keys
- API-key deployment guide: https://docs.thetatoken.org/docs/use-edgecloud-api-keys-to-manage-deployments
- GPU training nodes: https://docs.thetatoken.org/docs/edgecloud-ai-training-with-gpu-nodes
- Community GPU nodes: https://docs.thetatoken.org/docs/run-your-tasks-on-community-edgecloud-nodes

Controller base URL supplied by owner: `https://controller.thetaedgecloud.com`.
Hosted MCP endpoint documented by Theta: `https://controller.thetaedgecloud.com/mcp`.

Documented MCP permission classes:
- `inference`: list models, run inference and inspect results.
- `gpu:read`: inspect available GPUs, templates, nodes, logs and events.
- `gpu:write`: create, start, stop and delete GPU nodes; disabled by default.
- `billing:read`: read balance, usage, top-ups and pricing.

Theta documents separate project API keys for GPU/billing and on-demand API keys for model inference. Keys are project-scoped; the on-demand key is distinct. Never place either key in source control or browser code.

Theta's deployment guide explicitly says new GPU Node integrations should use its API v1; older `/deployment` endpoints remain for legacy deployment types. Before implementing GPU lifecycle calls, obtain and pin the current API v1 OpenAPI/schema and endpoint contracts. Do not build new GPU Node lifecycle operations on the legacy endpoint examples.

The supplied controller root was not authenticated or probed. Public documentation, not live API behavior, is the source for this plan.

## 3. Proposed architecture

### 3.1 Provider adapter (inference)

Add a dedicated Theta provider adapter behind the existing provider interface rather than special-casing Theta in route handlers.

Proposed modules:
- `src/providers/theta-edgecloud.ts`: Theta request/response normalization, model-specific request paths, streaming behavior only where documented and supported, timeout/abort propagation, safe error normalization.
- `src/providers/theta-edgecloud-config.ts`: validated base URL and model endpoint metadata; no credentials in model catalog rows.
- Extend provider resolution to use a server-side `THETA_ONDEMAND_API_KEY` (exact auth header to follow the selected model's current API specification).
- Add Theta models to `models_catalog` only after verifying exact model IDs, API paths, request schemas, context limits, modalities and price units from the live model catalogue/docs.
- Keep existing OpenAI-compatible providers unchanged.

Do not assume every Theta model uses the same OpenAI-compatible schema. Each model integration must be validated against its own published API specification. If an endpoint is not OpenAI-compatible, normalize it inside the adapter.

### 3.2 GPU control plane

Add a separate typed Theta client for GPU resources and lifecycle operations. Do not expose raw Theta MCP tools or arbitrary HTTP requests directly to HERMES or other agents.

Proposed modules:
- `src/integrations/theta/client.ts`: authenticated HTTP transport, strict origin allowlist, timeouts, bounded response sizes, redacted errors.
- `src/integrations/theta/schemas.ts`: runtime validation for resource, template, node, event, log and billing responses.
- `src/integrations/theta/policy.ts`: capability checks, per-action approval, USD-micros budget enforcement, project binding and lifecycle allowlist.
- `src/integrations/theta/gpu.ts`: read-only resource discovery and node inspection initially; create/start/stop/delete methods remain unavailable to normal agent tools until a later approval gate.
- `src/routes/admin-theta.ts` (or equivalent owner-only route): authenticated, auditable admin operations. Route naming and admin auth must follow existing conventions after detailed inspection.

Initial allowed operations:
- List available GPU resources and current published prices.
- List templates and allowed container images.
- Read existing project GPU nodes, status, events and logs.
- Read project balance, usage and pricing.

Initially prohibited:
- Create, start, stop, restart, reconfigure or delete any GPU node.
- Create persistent volumes or attach storage.
- Submit paid inference or training jobs without a separate approved test execution.
- Arbitrary container images, shell commands, SSH key injection, arbitrary URLs or public endpoints.
- Any wallet, blockchain signing, treasury, x402 or production secret access.

GPU write permission is a platform capability requested for eventual integration, not an instruction to enable it now. Keep the Theta MCP `gpu:write` permission off for the first connection.

### 3.3 MCP / agent integration

Do not attach Theta's hosted MCP server directly to user agents using a project key with `gpu:write`. Existing `src/agents/mcp.ts` exposes the configured server's discovered tools to the model; it does not yet enforce a Theta-specific action approval or cross-run budget policy.

Instead:
1. Implement a narrow internal MCP/tool facade backed by the typed Theta client.
2. Expose read-only tools to authorized agent roles first.
3. Put any future GPU write tool behind owner approval, an explicit allowlist, a server-side cost estimate, and a durable reservation.
4. Keep SENTINEL review independent; a model's own approval text is never sufficient authorization.

Suggested roles:
- HERMES: request/route work, no direct GPU write.
- INTELLIGENCE / AGENT-ENGINEER: inference and read-only GPU discovery.
- ARCHITECT: approve technical workload specification, not spend.
- SENTINEL: independently review security, permissions, spend and deployment plan.
- Owner: explicit approval for each GPU lifecycle action and any paid workload beyond approved test policy.

### 3.4 Spend and audit controls

The requested initial test ceiling is USD 1.00 = 1,000,000 USD micros. Implement an aggregate project-level cap across all Theta calls and all child agent runs, not a per-agent or per-request cap.

Requirements:
- Atomic spend reservation before any billable request.
- Settle reservation against actual provider cost when returned.
- Release unused reservation on failure/cancel/timeout.
- Unknown outcome after request submission must be treated conservatively as potentially spent until reconciled.
- Idempotency key for retried requests.
- Reject any call whose maximum possible charge cannot fit the remaining budget.
- Budget and billing values stored as integer USD micros; never use floating point for enforcement.
- Separate Theta spend ledger/audit records from customer credit ledger; do not silently charge users.
- Default to zero paid spend until the owner explicitly approves a specific test execution.
- Do not automatically top up or purchase TFUEL/credits.

The $1.00 ceiling is a hard maximum for a later explicitly authorized test, not permission to spend now.

## 4. Data model proposal

Design only; schema changes require implementation review.

Potential tables:
- `theta_projects`: internal project mapping, opaque Theta project ID, status, created/updated timestamps. Never store plaintext API keys.
- `theta_credentials`: credential metadata and encrypted secret reference or secret-manager reference; separate credential classes for project API and on-demand inference key; no secret values in logs.
- `theta_gpu_nodes`: provider node ID, project mapping, region, machine type, status snapshot, last observed time. Do not persist SSH private keys.
- `theta_spend_reservations`: idempotency key, reserved USD micros, state, operation, provider request ID, created/settled timestamps.
- `theta_usage_events`: operation, resource/model, estimated and actual cost micros, duration, outcome, correlation ID, agent/run IDs, provider request ID; no prompts, API keys, raw secrets or sensitive payloads.

Alternative: use existing generic provider usage tables for inference if their grain supports it, but GPU lifecycle and billing require a durable dedicated audit/reservation model.

## 5. Implementation phases

### Phase 0 — this branch: design and contract discovery
- Complete repository inspection.
- Pin official Theta API v1 schemas and on-demand model API contracts.
- Confirm API authentication headers, response formats, rate limits, idempotency, billing semantics, pricing units, regions, availability, cancellation and job status behavior.
- No credentials, authenticated calls, paid calls or infrastructure changes.

### Phase 1 — read-only integration
- Typed Theta client and response schemas.
- Resource/template/node/billing read methods only.
- Secret handling design and credential redaction tests.
- No GPU write endpoints in runtime route registration.

### Phase 2 — inference adapter
- Add verified models and provider adapter.
- Non-streaming and streaming tests only where supported.
- Timeout, cancellation, provider error and usage-cost accounting.
- No production provider default or automatic fallback changes.

### Phase 3 — owner-controlled paid inference smoke test
- Require explicit owner approval immediately before execution.
- Hard cap USD 1.00 across all Theta test calls.
- Start with one low-cost model and minimal prompt.
- Record request ID, model, input/output token counts, provider cost, latency and result status.
- Stop after one test unless the owner explicitly approves more.

### Phase 4 — GPU lifecycle (separate approval required)
- Add create/start/stop/reconfigure/delete only after API v1 contract verification, independent security review and budget reservation tests.
- Default disabled.
- Every write action requires owner confirmation showing project, GPU type, region, hourly price, estimated duration, storage, maximum cost and stop/deletion plan.
- Require explicit confirmation again for delete because it is destructive.

### Phase 5 — agent and RAG workloads
- Role-scoped read-only tools first.
- Add RAG/document indexing only after data residency, retention, access control and deletion semantics are reviewed.
- No agent self-service GPU creation until a separate owner-approved policy exists.

## 6. Test plan

### Unit tests
- URL/origin allowlist rejects non-Theta origins, redirects to untrusted origins, localhost, private IPs and malformed URLs.
- Auth header injection uses only server-side secret values and redacts all credentials from errors/logs.
- Request schema and response schema validation rejects malformed/unexpected payloads.
- Provider adapter normalizes success, usage, errors, streaming chunks, timeout and cancellation.
- USD-micros conversion and rounding are deterministic and overflow-safe.
- Budget reservation is atomic under concurrent requests.
- Aggregate parent/child agent spend cannot exceed 1,000,000 micros.
- Retry/idempotency cannot double reserve or double settle.
- Failed, timed-out, cancelled and unknown-outcome requests reconcile conservatively.
- GPU policy denies every write action by default.
- A read-only credential/tool surface cannot invoke create/start/stop/delete.
- Agent cannot override project ID, price, budget, GPU type allowlist or owner approval.
- Logs/audit records contain no API keys, prompts, SSH private keys or raw request bodies.

### Integration tests (mock Theta server)
- List resources, templates, nodes, events and billing with fixture responses.
- Simulate 401, 403, 404, 429, 5xx, malformed JSON, timeout and network reset.
- Verify retries are limited to safe idempotent reads unless Theta's idempotency semantics are confirmed.
- Verify no write endpoint is called in read-only mode.
- Verify paid inference requests are blocked unless an explicit test-run authorization is present.
- Verify aggregate cap stops requests before provider submission.

### Repository checks
- `npm run typecheck`
- `npm test`
- `npm run build:web`
- Any new security/agent platform validation scripts.
- Review dependency provenance, license, lockfile and package install lifecycle before adding Theta SDK. Prefer a small typed fetch client until the SDK's maintenance/security contract is assessed.

## 7. Acceptance gates

1. Official API v1 and inference contracts are pinned and reviewed.
2. All tests pass locally and in CI.
3. Independent QA and SENTINEL reviews approve the exact same commit SHA.
4. Read-only credentials are used for initial discovery.
5. Owner explicitly approves any paid inference test, with USD 1.00 aggregate maximum.
6. GPU write remains disabled until separate explicit owner approval.
7. No Vercel deployment, production configuration change, production data write, secret rotation, paid GPU node, or automatic provider-routing change occurs as part of the current design phase.

## 8. Open questions to resolve before implementation

- Which Theta project ID should be dedicated to Thirdeye staging?
- Does the owner already have separate project API and on-demand inference keys? Do not paste keys into chat or GitHub.
- Which initial inference models and modalities are desired?
- What current GPU Node API v1 OpenAPI/schema version and exact endpoints are supported by the account?
- What are the exact billing units, minimum charges, reservation semantics and refund/cancellation behavior?
- What are data retention, model-provider routing, region and privacy guarantees for each chosen inference model?

## 9. Explicit non-actions in this phase

- No credentials created, requested, read, copied or stored.
- No authenticated Theta API/MCP calls.
- No paid inference, top-up or GPU rental.
- No GPU node creation, start, stop, restart, reconfiguration or deletion.
- No production environment variables, secrets, database schema, deployment settings or provider routing changed.
- No Vercel deployment or plan upgrade.
