# RouterLink Provider Integration — Fix Plan

**Status:** Architecture plan; implementation not yet enabled  
**Repository:** `hakuramasam/thirdeye-ai`  
**Scope:** Add RouterLink as an upstream provider while preserving ThirdEye's public API, billing ledger, rate limits, BYOK encryption, and existing providers.

## 1. Executive diagnosis

ThirdEye already has an OpenAI-compatible public gateway and a provider resolver. Its current model registry is a local `models_catalog` table with only `model`, `provider`, `upstream_model`, `base_url`, two flat token prices, and `enabled`. The resolver recognizes `openai`, `anthropic`, and `mock`; other providers are treated as OpenAI-compatible and their BYOK/platform key name is inferred from the base URL hostname.

That is insufficient for RouterLink:

- RouterLink is a gateway with its own live logical-model catalog and multiple provider-channel implementations. The model vendor (e.g. Google, Qwen, Anthropic) is not the same thing as the provider channel (e.g. WORLD3 Router North America, GCP Vertex).
- A logical model can have multiple implementation rows, with a channel-specific upstream model ID, API standard, endpoint, context/output limits, and price.
- RouterLink exposes both OpenAI-compatible and Anthropic-compatible interfaces. The Anthropic endpoint and authentication differ from the existing direct Anthropic adapter.
- RouterLink pricing is per implementation, per token type, and can be tiered. ThirdEye already has flat input/output and cache-aware pricing, but its catalogue and reconciliation contract does not preserve RouterLink implementation-level metadata, tiered price cards, or all modality-specific rates.

**Root cause:** ThirdEye's adapter/catalogue contract assumes one provider endpoint + one flat rate per model. RouterLink requires a normalized model implementation registry, API-standard-aware dispatch, and accurate price/capability handling.

## 2. RouterLink documentation facts

The implementation must follow the live docs rather than hardcode a fixed model count or provider list:

- RouterLink describes itself as a unified gateway and documents OpenAI-compatible and Anthropic-compatible protocol formats.
- OpenAI-compatible base URL: `https://router-link.world3.ai/api/v1`; endpoint: `POST /chat/completions`; authentication: `Authorization: Bearer <key>`.
- Anthropic-compatible base URL: `https://router-link.world3.ai/api`; endpoint: `POST /v1/messages`; authentication: `x-api-key` plus `anthropic-version: 2023-06-01`.
- Live model discovery: `GET /api/v1/models`, paginated with `page` and `page_size` (maximum 100). The response contains logical model metadata such as vendor, tags, labels, context and output limits.
- Provider-channel implementations: `GET /api/v1/models/group?model_name=...`. The grouped response includes implementation model ID/name, `model_standard` (`OpenAI` or `Anthropic`), provider-channel alias, endpoint, vendor, context/output limits and pricing.
- Current provider-channel and vendor lists are available from `GET /api/v1/models/providers` and `GET /api/v1/models/vendors`.
- Pricing is per implementation and token type, expressed as USD per 1,000,000 tokens; tiers can have `token_min`, `token_max`, and separate input/output/cache/media rates. A zero price denotes a free tier.
- Supported request parameters vary by model and channel. The docs list common parameters including tools, streaming, response formats, modalities, reasoning effort and provider-specific extras, but do not promise that every model supports every parameter.

Official references:
- https://docs.routerlink.ai/
- https://docs.routerlink.ai/basics/quickstart
- https://docs.routerlink.ai/basics/models
- https://docs.routerlink.ai/basics/price

## 3. Target architecture

### 3.1 Provider identities

Add two explicit ThirdEye internal provider kinds:

- `routerlink-openai`
- `routerlink-anthropic`

Keep the upstream model identifier exactly as returned by RouterLink's implementation/group endpoint (including channel prefix). Do not reconstruct or strip the channel/model ID.

Use one platform secret, `PROV_ROUTERLINK_API_KEY`, for platform-brokered RouterLink calls. Add a BYOK provider name `routerlink` for users who supply their own RouterLink key, and add `routerlink` to the dashboard BYOK provider selector and credential save flow so user-owned keys can actually be selected. Never expose either key in model-list responses, logs, or errors.

The provider resolver must special-case both RouterLink kinds and resolve the credential under `routerlink`; it must not infer `world3.ai` or `router-link.world3.ai` as the BYOK/provider key name.

### 3.2 Endpoint and protocol dispatch

- OpenAI standard: use the documented base URL `https://router-link.world3.ai/api/v1` and append `/chat/completions`; Bearer authentication, OpenAI request/response and SSE semantics. Do not blindly persist the grouped implementation's generic `/api` endpoint for OpenAI rows.
- Anthropic standard: `https://router-link.world3.ai/api/v1/messages`, `x-api-key` authentication, required Anthropic version header, Anthropic request/response and event-stream semantics.
- Refactor the existing Anthropic adapter to accept an explicit base URL and authentication mode without changing the existing direct-Anthropic default.
- Keep ThirdEye's external API OpenAI-compatible. Normalize Anthropic responses and streams into the existing OpenAI-compatible response contract.
- Do not silently translate unsupported features. Reject unsupported modality or parameter combinations with a clear `invalid_request` response before spending upstream credits.

### 3.3 Model implementation registry

Treat each RouterLink channel implementation as a selectable ThirdEye model row. Keep logical-model display metadata separate from the exact upstream implementation ID.

Add an additive migration for metadata such as:

- `display_name`, `vendor`, `provider_channel`, `api_standard`
- `context_window`, `max_output_tokens`
- `capabilities` / `tags`, `labels`
- `source` (e.g. `routerlink`), `source_model_id`, `synced_at`
- `price_tiers` (versioned JSON) for exact per-token-type pricing where required
- `usage_source`, `usage_is_estimated`, `reservation_micros`, and `pricing_version` provenance on usage records

Do not overwrite user/admin-managed non-RouterLink catalogue rows during sync. Use a stable unique key based on RouterLink implementation identity, not display name alone. Preserve ThirdEye's public model aliases and canonical model lookup behavior.

### 3.4 Pricing and financial safety

RouterLink's `price_usd` is USD per 1M tokens. ThirdEye's `price_*_1m_usd_micros` is USD micros per 1M tokens, so conversion is:

`price_usd * 1_000_000` → USD micros per 1M tokens.

Do not flatten a tiered price card into a single arbitrary rate. The billing engine must either:
1. support the exact applicable tier and token-type calculation, or
2. keep that implementation disabled until accurate billing is supported.

Phase 1 must not activate a RouterLink row until the exact applicable input/output price is known and the full maximum-output exposure is reserved before dispatch. Flat, non-tiered text rows may be eligible after reservation controls are verified. Tiered rows remain disabled until tier-aware pricing, reservations, and reconciliation are implemented. Existing cache-aware pricing must be preserved; RouterLink cache tiers remain disabled unless the exact tier can be represented and reconciled. Audio, image, video, per-output media, and other non-text price types must remain unavailable until ThirdEye usage accounting and the public API can measure and charge them correctly.

Before every HTTP or agent upstream request, reserve a conservative maximum charge using the selected implementation's applicable price tier and requested output limit, enforcing prepaid balance and per-key budget. Reconcile the reservation against actual upstream usage after completion; release unused reservation. On missing usage, persist provenance and mark the event estimated/provisional rather than exact, and apply a defined conservative settlement policy. Apply the same controls in `src/agents/runner.ts`, not only the public HTTP route. Keep ThirdEye's own margin, prepaid balance, per-key budget, usage event, ledger debit, and reconciliation rules authoritative. RouterLink's own usage/billing dashboard is an upstream reference, not a replacement for ThirdEye's ledger. Do not automatically retry a request on a different channel after an ambiguous timeout: the first upstream may already have processed and charged it.

## 4. Delivery phases

### Phase 0 — Contract and safeguards

- Confirm RouterLink account/API-key availability outside chat; never ask the user to paste a key into a conversation.
- Add `PROV_ROUTERLINK_API_KEY` to deployment-secret documentation and `.env.example` as an empty placeholder only.
- Define provider kinds, implementation identity, supported capabilities, pricing precision and model sync rules.
- Add explicit opt-in for live upstream smoke tests; default CI uses mocked fetch and makes no paid RouterLink calls.

**Exit gate:** Reviewed provider contract and no credential/billing regressions.

### Phase 1 — Protocol adapters

- Add RouterLink OpenAI-compatible adapter using the documented base URL and Bearer header.
- Add RouterLink Anthropic-compatible adapter using the documented Messages endpoint and headers.
- Preserve upstream model IDs exactly.
- Normalize non-streaming usage, tool calls, errors and streaming events into ThirdEye's existing OpenAI response/SSE contract.
- Add timeout/abort behavior equivalent to existing provider adapters.

**Exit gate:** Unit tests for endpoint construction, auth headers, request mapping, tool calls, response mapping, SSE mapping, timeout and upstream error handling.

### Phase 2 — Live model discovery and sync

- Add a RouterLink catalogue client for paginated `GET /api/v1/models`, `/models/group`, provider list, and vendor list.
- Store implementation rows, not just logical model names.
- Import channel, API standard, vendor, model ID, context/output limits, tags, labels and pricing.
- Make sync idempotent; disable stale RouterLink rows rather than deleting historical model references.
- Add admin-only/manual sync and audit metadata. Do not make a public unauthenticated endpoint that can trigger outbound requests or rewrite the catalogue.
- Apply conservative allowlisting: only supported OpenAI/Anthropic text implementations with complete, currently billable price data and verified pre-call reservation become enabled. Keep tiered implementations disabled until tier-aware billing, reservation, and reconciliation are complete; a zero-priced tier does not make the entire implementation free.

**Exit gate:** Repeated sync produces no duplicates, preserves local models, and produces deterministic, explainable pricing.

### Phase 3 — Accurate billing and capability enforcement

- Extend price calculation and reconciliation together: version `RateRow`/`loadRates`/`rebuildCostMicros` around the exact tier card and preserve cache-aware pricing. Keep any row disabled until both live settlement and historical rebuild use the same pricing version.
- Apply the same exact tier/cache calculation, capability checks, pre-call reservation and post-call reconciliation to `src/agents/runner.ts` and agent tool execution.
- Validate model capabilities before dispatch; do not advertise audio/image/video until usage accounting supports them.
- Verify usage fields returned by each protocol and persist `usage_source`, `usage_is_estimated`, pricing version, and reservation/settlement provenance. Missing usage must remain explicitly estimated/provisional and must never be presented as exact.
- Add per-provider spend/latency/error metrics and upstream request IDs where available.

**Exit gate:** Tests prove exact cost math at tier boundaries, cache handling, free models, margin, BYOK metering, budget enforcement and failed-call handling.

### Phase 4 — Dashboard and public API

- Show RouterLink models with display name, vendor, provider channel, protocol, context/output limits, capability tags, labels and ThirdEye price.
- Update every model-discovery surface and UI consumer, including `/api/models`, `/api/models/public`, `/api/v1/models`, and the corresponding dashboard selectors; assert parity across all surfaces.
- Show channel-specific variants clearly; never collapse variants that have different endpoints, price or capabilities.
- Add provider credential status without exposing secrets, including the dashboard BYOK selector and save flow for `routerlink`.
- Keep `GET /api/v1/models` OpenAI-compatible and expose only enabled implementations.
- Add model detail/availability information for clients without leaking RouterLink credentials.

**Exit gate:** Dashboard and API show the same enabled model set and prices.

### Phase 5 — Staged activation

1. Mock-only CI and unit tests.
2. Operator-configured RouterLink key in the secret manager.
3. One opt-in, low-cost, text-only live smoke test with a hard request/token budget.
4. Compare RouterLink usage logs with ThirdEye usage event and ledger debit.
5. Enable a small allowlisted model set.
6. Expand catalog only after a period of clean usage reconciliation.

No production deployment, paid live test, pricing/margin change, or automatic provider failover is authorized by this plan.

## 5. Required tests

- Model list pagination and empty/partial/error responses.
- Group lookup with multiple channel variants for the same logical model.
- Exact preservation of upstream implementation model IDs.
- OpenAI Bearer and Anthropic `x-api-key` authentication; no key in logs/errors.
- Protocol-specific endpoint and request body.
- Anthropic-to-OpenAI tool-call and stream normalization.
- Context/output limit and capability validation.
- Pricing conversion from USD/1M to USD micros/1M.
- Tier boundary calculations, cache rates, zero-price models and unsupported media rates.
- BYOK and platform key resolution both map to `routerlink`, not the endpoint hostname.
- Sync idempotency, stale-model disabling, source isolation and catalogue alias compatibility.
- No duplicate charge/retry after ambiguous timeout.
- Existing OpenAI, Anthropic, OpenAI-compatible and mock regression tests remain green.

## 6. Decisions reserved for the operator

These are intentionally not inferred:

- Whether RouterLink is to be the default provider for selected vendors/models or an optional provider alongside direct providers.
- Whether RouterLink upstream cost is passed through with the current ThirdEye margin or a different commercial margin.
- Which RouterLink channel regions are acceptable for data residency/latency policy.
- Whether any RouterLink live test may spend account credits, and its maximum spend.
- Whether non-text models should be exposed after modality accounting is implemented.

Until approved, the safe default is optional RouterLink support, platform-owned secret stored only in Vercel/GitHub secret settings, text-only allowlist, existing margin policy, and no live paid test.

## 7. Current implementation blockers and known code touchpoints

- `src/providers/index.ts`: resolver only explicitly dispatches `openai`, `anthropic`, and `mock`; provider key lookup currently derives a hostname for generic OpenAI-compatible rows.
- `src/providers/openai.ts`: reusable OpenAI-compatible transport; currently uses Bearer auth and appends `/chat/completions`.
- `src/providers/anthropic.ts`: direct Anthropic Messages API currently hardcodes the Anthropic endpoint and direct-provider headers.
- `src/db/schema.sql`: model catalogue stores only flat input/output prices and no RouterLink implementation metadata.
- `src/lib/pricing.ts`: flat-rate and cache-aware calculations exist, but RouterLink tiered/media pricing is not represented.
- `src/routes/v1.ts`: model list is sourced from enabled local catalogue rows; this can remain the public contract after sync.
- `src/lib/env.ts` and `.env.example`: provider key map supports `PROV_<NAME>_API_KEY`; RouterLink needs an explicit stable provider identity.

**Do not mark RouterLink support complete merely because a model row appears in the dashboard.** Graduation requires successful mocked protocol tests, a live opt-in call, correct usage reconciliation, and proof that the agent runner can use the RouterLink-backed model through the same resolver.
