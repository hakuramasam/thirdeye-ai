# Partner discovery surfaces (2026-11-07)

Additive only: no existing route, price or behaviour changed. Live on
`https://thirdeye-ai-alpha.vercel.app`.

| Surface | Path | Auth |
| --- | --- | --- |
| Capability card | `/api/partner/capabilities` | none |
| Public model catalogue with prices | `/api/models/public` | none |
| Agent card | `/.well-known/agent-card.json` | none |
| A2A JSON-RPC | `/a2a` (alias `/api/a2a`) | none |
| Partner hub | `/partner` | owner session or partner key |

## Capability card

Mirrors Vesper's shape: `service`, `version`, `updated_at`, `operator`, `protocols`,
`endpoints`, `limits`, `strengths`, `gaps_we_do_not_fill`, `peers`. Their card was read live
before writing ours, so discovery is genuinely mutual rather than a guessed schema.

## Public model catalogue

`/api/models` stays behind a wallet session. `/api/models/public` exposes, per enabled model,
the catalogue price and the **billed** price per 1M tokens, with `margin_pct` stated. This
follows the standing rule that we never publish a price that understates what a customer pays.

## Agent card and A2A

`vercel.json` now routes `/.well-known/agent-card.json` and `/a2a` into the API function;
before that both fell through to the SPA fallback and returned `index.html`, which is why the
first deploy looked successful but served HTML.

A2A supports `message/send`, `agent/getCard` and `agent/authenticatedExtendedCard`. It performs
no inference and spends nothing: `message/send` returns a completed task whose artifact explains
how to get a key and where the priced catalogue lives. Streaming and `tasks/get` are refused with
JSON-RPC errors because the endpoint is stateless.

## Payment verification

Every paid x402 fetch now records a row in `agent_run_payments` (run id, seller host, tx hash,
chain, method, expected recipient/token/amount, verified_onchain, confirmations, replay, status)
and asks the partner's verifier. `replay=true` is classified as `replay` with
`verifiedOnchain: true`, never as an error.

**Corrected 2026-11-07.** An earlier reading of Vesper's `/verify` said verification was itself a
paid call. That was wrong. With a well-formed request the endpoint answers HTTP 402 *and returns a
complete on-chain result*: `confirmations: 906646`, `block: 53443985`, `from`, `exact_method.match`,
`errors: []`, and no payment requirements block. The 402 here is a status meaning "not verified",
not a payment demand.

Two consequences:
1. `verifyPayment` now judges by payload, not status code, so a 402 carrying evidence is recorded
   as a real result instead of `unavailable`. Regression covered by test.
2. Verifying costs nothing, so no allowlist entry or funding is needed **for verification**. A
   funded wallet is only needed to make a paid skill call that there is something to verify.

Not implemented: optional `receipt_stamp` receipt ids on run records.
