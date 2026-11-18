# Scoped proposal: cross-chain credit funding via LI.FI

Status: proposal only. No code, no route, no production change. Nothing here is enabled by merging this
document.

## The problem

Funding credits today requires holding USDC on Base. A customer with funds on Arbitrum, Optimism, Polygon
or Ethereum has to bridge manually before they can spend anything with us, and that is the first place the
funnel leaks. LI.FI aggregates bridges and DEX aggregators behind one API, so a customer can pay from any
supported chain and land USDC on Base in a single transaction they sign themselves.

## Non-goals, stated up front

- **We never take custody and never sign a bridge transaction.** The `transactionRequest` goes to the
  caller's own wallet. Our signing path is untouched by this work.
- **No integrator fee at launch.** The API supports one (`integrator`, `fee`, `feeSplit`), and adding it
  later is a parameter change, not a redesign. Charging on a route we have not measured yet would be a
  price we cannot defend.
- **No settlement on bridge status alone.** `/v1/status` returning `DONE` is evidence, not proof. Credit is
  only issued after our own onchain verification.
- **Not an x402 path.** This is funding, not per-call agent payment.

## API surface, read from `docs.li.fi/openapi.yaml`

Host `https://li.quest`, OpenAPI 3.0.2, 22 paths. Only five matter here.

`GET /v1/quote` — required: `fromChain`, `toChain`, `fromToken`, `toToken`, `fromAddress`, `fromAmount`.
Optional and worth wiring: `slippage`, `maxPriceImpact`, `denyExchanges`, `preferBridges`, `allowExchanges`,
`referrer`, `integrator`, `fee`. Response carries `action` (`fromChainId`, `fromAmount`, `fromToken`,
`toChainId`, `toToken`, `slippage`, `fromAddress`, `toAddress`), `estimate` (`toAmount`, `toAmountMin`,
`toAmountUSD`, `approvalAddress`, `feeCosts[]`, `gasCosts[]`, `executionDuration`, `hops`) and
`transactionRequest` inside each step.

`GET /v1/status` — the only expensive call in the flow, and the one that must never be polled in a loop.
`GET /v1/chains`, `GET /v1/tokens`, `GET /v1/connections` — to decide what to offer, never to guess a token
address from a symbol.

`FeeCost` fields (`name`, `percentage`, `token`, `amount`, `amountUSD`, `included`, `feeSplit`) are what the
UI would show so a customer sees the bridge cost before signing.

## Flow

1. Customer picks a source chain and token. We resolve the token through `/v1/tokens`, never from a
   hardcoded map keyed by symbol.
2. `GET /v1/quote` with `toToken` = USDC on Base and `toAddress` = the platform deposit address.
3. We return the `transactionRequest` plus the `estimate`, including `toAmountMin` and `feeCosts`, so the
   customer sees exactly what lands before they sign.
4. Customer signs in their own wallet. We never see a key.
5. We record a `payment_intents` row keyed by the source chain and tx hash, marked as a bridged intent with
   the tool and expected delivery amount.
6. `/v1/status` is checked **only on explicit user refresh**, with a small cap per deposit. No worker polls.
7. When the destination transfer is visible on Base, the existing verifier checks recipient and amount.
   Only then is credit issued, through the same idempotency layer that guards direct deposits today.

## Why step 7 is not optional

A bridge can report success while the destination amount differs from the quote, arrive late, or refund.
Crediting on status alone would let a failed route mint credits. The existing `verify.ts` recipient-and-amount
check is the authority, and the bridge API is only a hint about when to look.

## Data model

`payment_intents` gains: `provider` (`lifi` or null), `src_chain_id`, `src_tx_hash`, `bridge_tool`,
`expected_usdc_micros`, `poll_count`. The existing unique constraint on chain plus tx hash stays the
idempotency mechanism, so a double refresh cannot double credit.

## Rate limits and what they mean for us

200 requests per 2 hours without an API key, 200 per minute with one, and the ceiling is shared across the
REST API, the hosted MCP server and the CLI. A deposit flow touches `/v1/quote` once and `/v1/status` a few
times, so the unkeyed budget is fine for a pilot and not fine for scale. A key is a request to LI.FI, not a
purchase.

## Risks to model honestly

Bridge stalls between chains we do not control; partial delivery; `toAmountMin` slippage on volatile source
tokens; fee-on-transfer source tokens delivering less than quoted; a customer signing a quote against a
stale route. Each needs a status and a message, not a generic error. For the pilot I would accept only a
stablecoin source (USDC) on one chain to keep the failure surface small.

## Rollout

One env flag, `DEPOSIT_BRIDGE_ENABLED`, defaulting off. One pair first: USDC on Arbitrum One to USDC on Base.
A per-deposit cap while unmeasured. A kill switch that hides the option without a deploy.

## Tests to write before any of it ships

Quote parameter mapping; the status state machine including `PENDING` ageing out; the refusal path when the
destination amount is below `toAmountMin`; idempotency on a repeated refresh; and recipient mismatch. Fixture
payloads must be captured from the live API rather than invented, so the tests describe reality.

## Decisions needed from Sam

1. Integrator fee: I recommend 0 percent for the pilot.
2. First chain pair: I recommend USDC on Arbitrum One to Base.
3. Per-deposit cap while unmeasured.
4. UI first or API first. API first is cheaper and proves the flow with one tester.

## What would make this a bad idea

If bridge volume never justifies the failure surface, or if customers simply do not hold funds off Base. Both
are measurable cheaply: count how many prospective users ask for it before building the UI.
