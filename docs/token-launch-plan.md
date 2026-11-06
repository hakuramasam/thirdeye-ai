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
| 5 | Launch venue | **Clanker SDK** (see `docs/token-playbook.md`): ERC-20 + Uniswap v4 pool in one tx, 100% of fees to the treasury, `Paired` token, no dev buy |
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

### 4b. Valuation policy for THIRDEYE itself

Third-party tokens are valued by oracle spot price with a liquidity floor, deposit cap and haircut. The
platform token must **not** be valued that way: buying credit at the spot price of a pool we control is
circular. THIRDEYE deposits convert at an ops-published policy rate, and the oracle path stays reserved
for tokens we do not control. This follows the security skill's rule that a DEX spot read is not a
pricing source.

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


## Testnet rehearsal (Base Sepolia, 84532)

Before anything irreversible happens on Base mainnet, the launch flow is rehearsed on
Base Sepolia with testnet money.

- `node scripts/rehearse-sepolia.mjs` checks every prerequisite and touches nothing else:
  RPC chain id, deployer balance, compiler availability, and that Circle's test USDC
  exists on the network. It exits non-zero and lists exactly what is missing.
- `node scripts/rehearse-sepolia.mjs --deploy` deploys the test token once the checks pass.

**Hard rule: no testnet chain may ever be registered in `CHAINS`.** A registered
stablecoin is valued 1:1 with no oracle, so a Sepolia entry in the production registry
would let anyone send free testnet USDC and receive real credit. `tests/testnet-guard.test.ts`
enforces this. The rehearsal script therefore talks to Sepolia directly and never writes
to the production database or the production API.

Credentials: `SEPOLIA_DEPLOYER_KEY` is a dedicated testnet key, never the mainnet agent
key, and never a key that has held real funds.


## Fork-less rehearsal against live Base state

`scripts/rehearse-clanker-sim.mjs` runs the real Clanker factory call as `eth_call` with a
state override that funds the deployer, against live Base mainnet state. Nothing is signed
or broadcast, so the rehearsal costs nothing.

Established by running it on 2026-11-06:

- Clanker v4 factory on Base: `0x250c9FB2b411B48273f69879007803790A6AeA47` (code present).
- `deployToken(string,string,uint256,int24,uint24,bytes32,address)`.
- `predictToken` returns the counterfactual token address for a given salt.
- `getTickFromMarketCap(20)` returns WETH pairing at tick `-223400` (about 20 ETH FDV), and
  `FEE_CONFIGS.StaticBasic` maps to lpFee `10000` (1%).
- For USDC pairing the SDK exposes `getTickFromMarketCapUSDC` / `getTickFromMarketCapStable`,
  not the WETH helper.

**Known blocker:** `deployToken` reverts with "Invalid salt". The factory validates its own
salt scheme, and `generateSalt` returns more than a single bytes32 on this deployment, so the
salt cannot simply be guessed. The correct calldata has to come from the SDK's own deploy
path, which is the next step: either pin the SDK major that still exports the `Clanker` class
(the installed build does not) and capture its prepared transaction, or install Foundry and
run the SDK against a real `anvil` fork of Base.


## Rehearsal v2: the real SDK builds the call, live Base state executes it

`scripts/rehearse-clanker-v4.mjs` is the working rehearsal. The deploy class lives at the
subpath `clanker-sdk/v4` (not the package root), and `Clanker#getDeployTransaction` returns
a viem contract request, which the script encodes to calldata.

Result on 2026-11-06:

- Target contract `0xE85A59c628F7d27878ACeB4bf3b35733630083a9`, `value 0`, calldata 4,810 chars.
- Function `deployToken` with a `tokenConfig` struct (tokenAdmin, name, symbol, salt, image, ...).
- `eth_call` with a funded state override **SUCCEEDS** against live Base state and returns the
  token address it would create: `0x611ae47d59852c50bb29d3f09fccde986de39f61`.
- Wallet is a stub whose `writeContract`/`sendTransaction` throw, so the script cannot broadcast
  by accident.

USDC pairing needs `getTickFromMarketCapUSDC` (not the WETH helper), and one pool position
must touch the starting tick, so positions are built from that tick.

Still to rehearse before mainnet: the vault and airdrop config blocks, a non-zero salt
(the SDK emits `0x00…00` by default), and the real seed sizing rather than the `$100_000`
placeholder used here.


## Vault and airdrop rehearsal findings (2026-11-06)

The full launch shape now simulates successfully against live Base state: calldata grew from
4,810 to 6,026 chars and still returns `0x611ae47d59852c50bb29d3f09fccde986de39f61`.

Config that works:

```js
vault: { percentage: 38, lockupDuration: 2_592_000, vestingDuration: 0, recipient: TREASURY },
airdrop: { ...airdrop, lockupDuration: 86_400, vestingDuration: 0 },   // singular key
```

Three constraints the SDK enforces that the plan did not account for:

1. The key is **`airdrop`** (singular), built with `createAirdrop([...])` from
   `clanker-sdk/v4/extensions`. Passing `airdrops` fails validation.
2. **`lockupDuration` minimum is 86,400 seconds (1 day).** A zero-lockup ops float at deploy is
   not expressible through the airdrop extension. One day is the floor.
3. **`amount` minimum is 250,000,000.** A 20,000,000 (2%) airdrop was rejected. If `amount` is
   whole tokens, the smallest airdrop this extension allows is 25% of a 1B supply, which makes a
   2% ops float impossible by this route. This needs resolving before the allocation table is
   final: either deliver the float through the vault, accept a much larger airdrop, or decode the
   extension bytes to confirm the unit convention.


## Settled: airdrop and vault limits (verified 2026-11-06)

The airdrop `amount` unit question is settled by decoding what the SDK actually builds.
`createAirdrop([{ account, amount: 250_000_000 }])` produces a merkle leaf of
`["0x73fA…Cf0d", "250000000000000000000000000"]`, which is 250,000,000 × 10^18. So
**`amount` is whole tokens**, scaled by 1e18 internally, and the schema floor of 250,000,000
is therefore **250,000,000 whole tokens, i.e. 25% of a 1B supply**.

Verified constraint map, by building the deploy transaction and letting the schema judge:

| Parameter | Limit | Note |
| --- | --- | --- |
| `vault.percentage` max | **90** | 95 rejected; so at least 10% always reaches the pool |
| `vault.lockupDuration` min | **604,800s = 7 days** | 1 day rejected; 2%/7 days accepted |
| `vault` shape | single object | an array of vaults is rejected |
| `airdrop.amount` min | **250,000,000 tokens** | 20,000,000 (2%) rejected |
| `airdrop.lockupDuration` min | **86,400s = 1 day** | 25%/1 day accepted |
| key name | `airdrop` singular | `airdrops` rejected |

### What this does to the allocation table

1. **"5% into the pool, 95% to the vault" cannot be built.** The vault caps at 90%, so the pool
   floor is 10% of supply. At 1B that is 100M tokens, not 50M, which halves the launch price for
   the same seed: $5,000 against 100M is $0.00005 per token, a $50,000 FDV.
2. **"2% liquid at day 0 with zero lockup" cannot be built.** The earliest anyone can hold
   unlocked tokens is day 1 via an airdrop, and that airdrop must be at least 25% of supply.
3. **Only one vault cliff is expressible.** So the nine-bucket unlock schedule cannot live in
   Clanker. The workable shape is: one vault (e.g. 90% at a 30-day cliff) to the treasury, then
   Sablier streams from the treasury for each bucket, which is where the real schedule belongs.

### Workable shapes to choose from

- **A. Vault 90% / 30 days, pool 10%.** Simplest, keeps the treasury whole, requires $10,000
  seed to reach the same $0.0001 price. No day-0 float; distribution happens through Sablier
  after unlock.
- **B. Vault 75% / 30 days + airdrop 25% / 1 day.** Gives a genuine day-1 liquid float, but at 25%
  of supply rather than 2%, which is a much larger unlock than planned.
- **C. Small vault now, rest streamed later.** Vault 2% / 7 days for an early ops float plus a
  large vault is not possible with one vault object, so this shape needs the float to come out of
  the treasury vault after unlock instead.


## Reshaped launch: 250M airdrop (Sam's decision, 2026-11-06)

Clanker cannot express the original 2% zero-lockup float, so the launch is reshaped to the
smallest airdrop the extension allows, sent to the wallet that creates the token.

| Bucket | Share | Tokens | Where it goes | Unlocks |
| --- | --- | --- | --- | --- |
| Pool float | 5% | 50,000,000 | Uniswap v4 THIRDEYE/USDC | At launch |
| Airdrop | 25% | 250,000,000 | Deployer/agent wallet `0x3F3C…8dEF` | **Day 1**, no vesting |
| Vault | 70% | 700,000,000 | Treasury vault `0x73fA…Cf0d` | Day 30 cliff, no linear tail |

Inside the 70% vault: dev & ops 12%, community 10%, partner incentives 6%, promo limit-price
buyers 4%, platform airdrops 3%, early member airdrop 3% (38% total), treasury reserve 32%.
The old 2% ops float is replaced by the 250M airdrop.

Verified by simulation against live Base state (calldata 6,026 chars, deploy SUCCEEDS, token
`0x611ae47d59852c50bb29d3f09fccde986de39f61`). The airdrop merkle root for this recipient is
`0x3d86942aed2fd74e734476589115b3704e6d859ad06a2db19e5b1fcd3ac1742c`, with the leaf
`["0x3F3C5af93542B42E5f457CB3711Bc551f2898dEF", "250000000000000000000000000"]`.

Seed economics return to the original target: $5,000 against a 50M float is $0.0001 per token
and a $100,000 FDV.

### Risk this shape introduces

Liquid supply is **five times the pool depth** at day 1. Selling the whole airdrop into that
pool returns about **$4,167** and moves the price **-97%**, because
250M tokens meet a 50M-token pool. Mitigations, in order of effectiveness:

1. Move the claimed 250M from the hot agent wallet into the Splits treasury (passkey custody)
   rather than leaving it where a single key can move it.
2. Raise the seed so the pool is deeper than the liquid supply.
3. Treat the 250M as non-circulating and stream out only what is needed.

Custody note: the airdrop recipient is the Privy agent wallet, a hot key. Whoever holds that key
can move 250M tokens (25% of supply) from day 1.


## Post-deploy sweep into the treasury

`scripts/sweep-airdrop-to-treasury.mjs` moves the claimed airdrop out of the hot deployer
wallet into the passkey-controlled treasury. Run it with tsx:

```bash
THIRDEYE_TOKEN_ADDRESS=0x... npx tsx scripts/sweep-airdrop-to-treasury.mjs            # dry run
THIRDEYE_TOKEN_ADDRESS=0x... npx tsx scripts/sweep-airdrop-to-treasury.mjs --confirm  # send
```

Guards, all covered by tests: refuses on a malformed or missing token address, refuses when
treasury and deployer are the same wallet, refuses a zero balance, refuses when gas is below
0.0005 ETH (a sweep that cannot pay for itself leaves tokens where they were), and supports a
reserve floor so a slice stays behind. It simulates the transfer before sending and verifies the
treasury balance after.

Verified in inspect mode against live state: pointed at the deployed TREND token it read the
deployer balance correctly and stopped on the gas guard with
`0.00000816457459746 ETH is below the 0.0005 ETH minimum`, sending nothing.

**Still missing for a fully automatic post-deploy flow:** the airdrop CLAIM step. The 250M only
lands in the deployer wallet after a claim transaction against Clanker's airdrop claim contract,
using the merkle proof from `createAirdrop`. That call is not scripted yet, so today the sequence
is claim by hand, then sweep by script.
