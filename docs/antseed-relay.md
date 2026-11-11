# Antseed relay: selling the market analyst as a service

Antseed bans providers that resell raw API access, so the only listing we may run is its "AI Agent"
provider type: a named service with our own persona, guardrails and data. This document covers the
endpoint that makes that true in code, and the key that caps what it can spend.

## Why not just point the seller at `/api/v1/chat/completions`

Because that route accepts an arbitrary prompt, an arbitrary model and tools. A marketplace buyer
would then be buying GPT-4o through us at our margin, which is reselling by another name, and one
runaway buyer would drain the free-tier RPM that live customers share. The relay exists to make
that impossible rather than discouraged.

## The endpoint

`POST /api/antseed/v1/chat/completions` - OpenAI-compatible, so Antseed's `openai` plugin points at
it with `baseUrl: https://<host>/api/antseed`.

What the policy layer (`src/antseed/analyst.ts`) enforces before the shared gateway handler sees the
request:

| Caller sends | What happens |
| --- | --- |
| `system` / `developer` / `tool` messages | discarded; our fixed persona is injected instead |
| `model` | replaced with the operator's model (`ANTSEED_ANALYST_MODEL`, default `gpt-oss-120b`) |
| `max_tokens` | clamped to `ANTSEED_MAX_TOKENS` (default 900, hard cap 4096) |
| `temperature` | clamped to 0.7 |
| `tools`, `tool_choice`, `functions`, `response_format` | dropped |
| conversation over 24 turns | oldest turns dropped |
| conversation over 24,000 characters | refused with `413 prompt_too_large` |
| no user turn at all | refused with `400 invalid_request` |

Anything narrowed is reported back in the `X-Thirdeye-Policy-Notes` response header, so a buyer can
see what changed instead of guessing.

Because the request is handed to the same `chatCompletionsHandler` as the public gateway, billing,
rate limiting, the per-key monthly budget and the measured `X-Thirdeye-Cost-Usd` header are
identical. There is one charging path, not two.

## The key

Relay keys carry `scope = 'antseed'`, and the wall runs both ways:

- an `antseed` key is refused on `/api/v1/*` with `403 wrong_key_scope`
- an `api` key is refused on `/api/antseed/*` with `403 wrong_key_scope`

Create one with a hard monthly ceiling:

```bash
curl -sX POST https://<host>/api/keys \
  -H "Content-Type: application/json" \
  -H "Cookie: <session>" \
  -d '{"name":"antseed-relay","scope":"antseed","rpm":30,"tpm":60000,"budget_usd_micros":5000000}'
```

`budget_usd_micros` is a real cap, not a warning: once the period's spend reaches it, calls answer
`402 budget_exceeded` until the next UTC month or until the cap is raised. `5000000` is $5.

Suggested starting shape for the seller: `rpm: 30` (matches the Groq free-tier ceiling so a demand
spike cannot starve real customers), `tpm: 60000`, and a budget you would be content to lose in a
month while the service is unproven.

## What a buyer, and we, can see

- `GET /api/antseed/service` - public descriptor: service id, model, limits, and the policies above.
- `GET /api/antseed/v1/models` - the single model this service exposes (relay key required).

## Pricing discipline

Do not name a price until the relay has served real traffic. The number to price against is the
billed figure from `X-Thirdeye-Cost-Usd` on relay calls, not catalogue arithmetic: the catalogue
excludes the platform margin. Then set the Antseed per-million price above measured upstream cost
plus the 4% protocol fee plus Base gas for `reserve`/`settle`.

## Known gaps

- No tools or browsing, by design. A question needing live prices should be answered as "needs
  verification" rather than estimated.
- The persona is English-only. Non-English traffic will be answered in English.
- There is no per-buyer quota. The cap is per key, so one noisy buyer can consume the month's budget
  for everyone. If that becomes real, the fix is per-caller rate limiting keyed on the buyer identity
  the seller forwards, not a bigger budget.
