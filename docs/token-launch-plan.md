# Platform token (THIRDEYE): launch pipeline

Status: pipeline wired, token not deployed. Nothing below spends funds or touches a chain until the
parameters are signed off.

## Why the token exists

One purpose only: let the people who actually consume Thirdeye settle in the platform's own unit, and
give the usage metrics a public, verifiable surface. It is not a fundraising instrument. There is no
pre-sale in this plan, and nothing here should be read as an investment offer.

## Decisions required before deploy

| # | Decision | Default if Sam says "go with defaults" |
| --- | --- | --- |
| 1 | Name / symbol | `Thirdeye` / `THIRDEYE` |
| 2 | Chain | Base (8453) — same chain as USDC deposits and the settlement vault |
| 3 | Supply | 1,000,000,000 fixed, no mint function, no owner |
| 4 | Decimals | 18 |
| 5 | Launch venue | Plain ERC-20 + Uniswap v4 pool seeded with USDC (no launchpad fee skim) |
| 6 | Initial float | 5% of supply into the pool, 95% held by the treasury vault |
| 7 | Deposit bonus | `PLATFORM_TOKEN_BONUS_BPS=1000` (+10% credit) |

If the venue instead becomes Clanker or Pons, the token is minted by that contract and steps 2 and 5
change; everything downstream (registry, verification, toggle, metrics) stays identical.

## Pipeline stages

### 1. Contract

- OpenZeppelin-style ERC-20, fixed supply minted once to the Splits treasury vault
  (`0x73faf95b2baa23bde4ce8547b64c55159022cf0d`), no mint, no pause, no tax, no blacklist.
- Rationale: a token with hidden transfer hooks breaks deposit verification and invites the exact
  liquidity games the $TREND lesson already showed.
- Deploy script lives beside the contract and refuses to run unless `--confirm` is passed and the
  target chain id matches.

### 2. Liquidity

- Single Uniswap v4 THIRDEYE/USDC pool, seeded from the treasury.
- Until that pool clears the liquidity floor, platform-token deposits stay disabled by design.

### 3. Registry (code, already implemented)

`src/lib/env.ts` reads:

- `PLATFORM_TOKEN_ADDRESS`, `PLATFORM_TOKEN_SYMBOL`, `PLATFORM_TOKEN_DECIMALS`
- `PLATFORM_TOKEN_BONUS_BPS`, `PLATFORM_TOKEN_MAX_DEPOSIT_USD`, `PLATFORM_TOKEN_MIN_LIQUIDITY_USD`

`src/payments/chains.ts` → `registerPlatformToken()` appends the token to the Base token list at boot.
The moment the address is set and redeployed, `/api/credits/deposit-info` advertises it and
`verifyDeposit` accepts transfers to the receiver automatically. No further code change is needed to
start taking it.

### 4. Deposit verification

`src/payments/verify.ts` already handles the two cases:

- stablecoins: credited 1:1 from the transfer amount;
- oracle-priced tokens: quoted through `src/payments/oracle.ts`, gated by
  `minLiquidityUsd`, capped by `maxDepositUsd`, adjusted by `haircutBps`.

The platform token is registered with `haircutBps: 0` because paying in our own token earns the bonus
(`PLATFORM_TOKEN_BONUS_BPS`) rather than a discount.

### 5. "Pay in token" toggle (implemented)

- Column: `users.pay_in_token boolean not null default false`.
- `GET /api/me` returns `user.pay_in_token` plus a `platform_token` block (null until live).
- `PATCH /api/me/preferences { "pay_in_token": true }` sets it.
- UI: a card on the deposit page ("Settle in THIRDEYE") that stays dimmed with an explanatory note
  until the token is live.
- Semantics, stated plainly: the flag is a preference, not a contract. Usage is still metered and
  debited in USD value; paying in THIRDEYE changes which asset is credited and applies the bonus.

### 6. Metrics feed and tokenization layer

- `GET /api/stats/public` already returns totals (requests, tokens, inflow, outflow, users) plus
  30-day series for usage and inflow/outflow.
- Next step for tokenized metrics: a signed snapshot, `GET /api/stats/public/snapshot`, HMAC'd with
  `MASTER_KEY`, carrying `{ as_of, totals, series_hash }`. An onchain attestation or a vault share
  contract then consumes that signed value instead of trusting a live HTTP read.
- Keep the feed public and the signing key server-side. A tokenized metric is only worth something if
  the underlying number cannot be back-dated.

## Rollout order

1. Contract source + local compile + tests (supply, no-mint, transfer, approval).
2. Deploy to Base, verify on Basescan.
3. Seed the Uniswap v4 pool from the treasury.
4. Set env (`PLATFORM_TOKEN_ADDRESS`, bonus, caps), redeploy.
5. Confirm `/api/credits/deposit-info` lists THIRDEYE and `/api/me` returns the token block.
6. Small live test: deposit a few dollars of THIRDEYE from a registered wallet, confirm credit and bonus.
7. Only then turn on customer-facing marketing.

## Risks to state out loud

- **Regulatory**: a token with a bonus for usage can look like an incentive or a security depending on
  jurisdiction. Get real advice before any public sale or yield framing. This plan contains no sale.
- **Thin-market loop**: if THIRDEYE deposits are credited at pool price, someone with pool control can
  inflate credits. The deposit cap and liquidity floor blunt it; they do not eliminate it.
- **Accounting**: token revenue is not USD revenue. Ledger stays in USD micros; the token is an asset
  in the treasury, valued at transfer time.
- **Complexity**: every additional accepted token is another oracle, another cap, and another thing
  that can break silently.
