# HERMES Provider Pilot — Staging Implementation Plan

**Status:** Gate B preparation; no provider switch or paid test authorized  
**Scope:** non-production staging only  
**Budget ceiling:** USD $5 (planning ceiling; no spend authorized)  
**Primary candidate:** OpenAI API  
**Backup candidate:** Google Gemini API  
**Production:** current Mistral configuration remains unchanged

## 1. Repository findings

The current application is an OpenAI-compatible gateway and agent runner:

- `src/agents/runner.ts` loads the agent's model row with `getModelRow` and resolves it through `resolveProvider`.
- `src/providers/index.ts` currently dispatches `mock`, `anthropic`, and OpenAI-compatible chat-completions calls.
- `src/providers/openai.ts` posts to `/chat/completions` and normalizes content, token usage and tool calls.
- `src/db/schema.sql` stores the public model ID, provider, upstream model ID and base URL in `models_catalog`.
- Provider credentials are resolved at runtime from BYOK or `PROV_<NAME>_API_KEY` environment variables.

The current implementation does not yet provide a dedicated Gemini provider mapping. The generic OpenAI-compatible route may be reusable, but its provider-key derivation must be made explicit and covered by tests before Gemini can be used. The OpenAI Responses API is not interchangeable with the existing Chat Completions contract; the pilot should use a verified Chat Completions-compatible endpoint/model first, rather than silently changing the runner protocol.

## 2. Candidate identity policy

Do not hard-code model IDs from this proposal. Before staging execution, verify the exact currently available model IDs, endpoint compatibility, tool/function calling support, structured-output support, account limits and published prices against each provider's official model catalog.

Store the verified values in staging-only model catalog rows. Do not seed new provider models into production schema or production data as part of this pilot.

## 3. Implementation sequence

### B1 — Provider compatibility tests (no network)

- Add unit tests for explicit provider identity resolution from catalog metadata.
- Add regression tests for OpenAI and Gemini provider-key selection.
- Verify the Gemini OpenAI-compatible base URL is normalized without duplicating path segments.
- Verify tool-call request/response normalization, malformed responses and upstream error mapping.
- Verify no provider key, request body or authorization header is written to logs or error payloads.

### B2 — Minimal adapter support

- Keep the existing OpenAI Chat Completions implementation unchanged for OpenAI.
- Add explicit provider metadata/key mapping for Google rather than deriving the key name from a hostname heuristic.
- Reuse the existing OpenAI-compatible transport only after official endpoint compatibility is verified.
- Keep provider selection data-driven through model catalog rows.
- Do not add fallback behavior that retries a failed paid request against another provider automatically. Cross-provider failover can duplicate spend and complicate tool-call idempotency.
- Keep retry budgets bounded by the existing invocation deadline and record 429/5xx/timeout classes distinctly.

### B3 — Staging-only configuration

- Use a dedicated staging database branch and staging model catalog rows.
- Use isolated staging runtime configuration; never reuse production agent rows or production provider keys.
- Configure no credentials in this preparation phase.
- Do not enable the candidate model for public users.
- Keep the HERMES staging agent disabled until Gate C.

### B4 — Test harness

Use synthetic, deterministic inputs and a mock provider for offline tests. Once Gate C is approved, run a small number of real staging calls under the $5 aggregate cap.

Measure:
- request success and failure rates;
- 429 frequency and retry outcome;
- tool-call correctness;
- structured-output validity;
- latency (median and p95);
- input/output token usage;
- estimated and provider-reported cost;
- artifact creation/read correctness.

## 4. Budget enforcement

The USD $5 ceiling is an aggregate hard stop across both providers, not a per-provider allowance. Before any paid call is authorized, the staging harness must:

1. Estimate the maximum request cost from the verified model price.
2. Refuse a request if the remaining budget cannot cover its configured maximum.
3. Record provider-reported usage and reconcile it with the estimate.
4. Stop all tests when the cumulative spend reaches the cap.
5. Treat missing usage/pricing data as a refusal, not a free request.

No auto-recharge, credit purchase or billing-plan change is permitted.

## 5. Acceptance gates

- [ ] Exact provider model IDs verified from official catalogs.
- [ ] Chat Completions compatibility verified for the selected model.
- [ ] Gemini provider-key mapping covered by tests.
- [ ] Tool-call and structured-output regression tests pass.
- [ ] Staging database isolation verified.
- [ ] No production database or agent row touched.
- [ ] QA independently verifies test results.
- [ ] SENTINEL independently verifies credential isolation, budget stop and no cross-provider duplicate-spend path.
- [ ] Gate C explicitly approved before credentials or paid API calls are used.

## 6. Explicit exclusions

This branch must not change production provider/model rows, production environment variables, secrets, schedules, DNS, billing, wallets, treasury, user balances, or production deployments. It must not merge itself or any other PR.

## 7. Current decision

Proceed with offline implementation and tests only. The provider model IDs remain intentionally unresolved pending authoritative availability checks. OpenAI is the primary evaluation target; Gemini is the backup. Mistral remains the production provider.
