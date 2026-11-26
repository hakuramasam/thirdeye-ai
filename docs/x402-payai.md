# ThirdEye AI — PayAI x402 gateway

This adds an isolated Express serverless endpoint alongside the existing Hono API. It does not replace the main API runtime, credit ledger, or payment-review workflow.

## Packages

Installed dependencies:

```bash
npm install express dotenv @payai/facilitator @x402/core @x402/express @x402/evm
```

## Routes

- `GET /api/x402/status` — reports configuration readiness without exposing secrets.
- `GET /api/x402/premium` — demonstration paid endpoint, protected by x402 exact EVM payments on Base Mainnet.

The PayAI facilitator verifies and settles x402 payments. The demonstration route does not automatically mint ThirdEye credits, alter account balances, or invoke the existing deposit conversion pipeline. Those financial ledger integrations require a separate idempotent settlement design and reconciliation tests.

## Environment

Set these values in the Vercel project environment only after reviewing the receiving wallet and price:

| Variable | Required value |
|---|---|
| `X402_ENABLED` | `true` to activate; otherwise the paid route remains disabled |
| `X402_PAY_TO` | Explicit Base-compatible EVM receiving wallet |
| `X402_PRICE_USD` | Dollar price such as `$0.01` |

No receiving wallet or price is hard-coded. The service fails closed when any setting is missing or invalid. Do not set these in production until the wallet owner, treasury routing, pricing, and accounting treatment are approved.

## Deployment

The endpoint is a separate Vercel function at `api/x402.js`. Existing Hono routes remain unchanged. The Vercel rewrite routes `/api/x402/*` to this function.

## Safety boundaries

- Base Mainnet only (`eip155:8453`); no testnet or Solana route is advertised.
- PayAI's public facilitator configuration is used; capability support should be checked against its live `/supported` response before enabling.
- Payment settlement is not the same as ThirdEye credit issuance. No automatic crediting or token conversion is implemented here.
- Keep the route disabled until the CI build, preview deployment, and a controlled low-value end-to-end test pass.
