# Token playbook (distilled from installed skills)

Installed skills live in `/app/.agents/skills/`: `eth-audit`, `eth-security`, `eth-testing`, `eth-qa`,
`eth-standards`, `eth-addresses`, `eth-gas`, `eth-l2s`, `eth-indexing`, `eth-tooling`, `eth-why`,
`eth-frontend-ux`, `eth-frontend-playbook`, `eth-orchestration`, `base-build-on-base`, `clanker`.

This page is the short version we actually follow. The skills are the source of truth.

## 1. Launch order (orchestration skill)

Three moves, never one:

1. contracts local, frontend on localhost;
2. contracts live, frontend still localhost — real chain, real gas, real decimals;
3. frontend public.

Go/no-go gates we must name out loud, not skip:

- before the live deploy: contract tests pass, the deploy script runs clean against a local fork of
  Base, and the deployer is funded on Base;
- before the UI is public: a full user journey walked with a real wallet and real money ($1–10);
- after the UI is public: load the public URL yourself and push one transaction through it.

Verify on Basescan in the same breath as deploy. An unverified token is opaque bytecode to every
integrator.

## 2. Venue: Clanker SDK first (clanker skill)

`clanker-sdk` deploys an ERC-20 **and** its Uniswap v4 pool in one transaction, which removes the two
things we would otherwise hand-roll: token bytecode and pool seeding.

Options that matter to us:

| Option | Effect | Our setting |
| --- | --- | --- |
| `rewards.recipients[].bps` | splits pool trading fees | 100% to the treasury vault |
| `rewards.token` | `Clanker`, `Paired`, or `Both` | `Paired` (WETH) — we do not want fee income in our own token |
| `vault` | locks a % with cliff + linear vesting | only if we want a locked treasury tranche |
| `airdrop` | merkle distribution at launch | not in v1 |
| `devBuy` | buys at deploy | none: no insider buy at launch |
| `vanity` | vanity address | optional, cosmetic only |

Two rules from the SDK worth pinning: fees default to the creator via `tokenAdmin`, and the 20%
`BANKR_INTERFACE_ADDRESS` fee only applies when deploying through Bankr — deploying with the SDK
directly avoids it.

## 3. Security rules that change our design (security skill)

The skill is blunt about one thing we currently do: **never price with a DEX spot read**. Our deposit
verifier values non-stable tokens from GeckoTerminal, which is a spot quote. For a third-party token
with an outside market that is a bounded risk (we cap it and haircut it). For **our own token** it is
circular: we would mint platform credit out of a pool whose depth we control.

Decision this forces: the platform token is valued by **policy rate** set by ops, not by our own pool's
spot price. Deposits in THIRDEYE convert at that published rate; the oracle path stays for third-party
tokens only.

Other rules we adopt:

- credit deposits from the received amount (already the case), never the requested amount;
- `SafeERC20` semantics on any contract we write, checks-effects-interactions, reentrancy guard;
- every swap we ever initiate needs a real `amountOutMinimum` and a real deadline, never `0`;
- authority (pause, parameter changes, rescue) behind a multisig or timelock — our Splits vault with
  passkey signers is exactly that shape already;
- test zero, max, rounding, fee-on-transfer, stale-price, and unauthorized-caller paths.

## 4. Testing bar before deploy (testing + audit skills)

A green suite is not evidence. Before the token deploys:

- fuzz every owner-settable number that feeds value math (`bound()`, not hand-picked values);
- invariants where state is involved: supply conservation, balances sum to supply, no mint path;
- fork Base at a pinned block for anything touching the real pool or USDC, on an endpoint confirmed to
  serve that block;
- `slither .` with no open high/medium;
- audit checklists are pinned by commit (`evm-audit-general`, `evm-audit-precision-math`,
  `evm-audit-erc20`); findings never get published anywhere without explicit permission.

## 5. Cost and chain facts (gas + addresses skills)

- Never quote gas from memory: read `cast gas-price` at the time, and on Base remember the L1 data fee
  is a **separate** component from `gasUsed × gasPrice`.
- Base native USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, WETH is
  `0x4200000000000000000000000000000000000006`. Both already used by the deposit path.
- Same address on two chains proves nothing; check per chain before promising a deployment exists.
- For USDC/WETH depth on Base, Aerodrome **Slipstream** has historically held the deeper book than the
  vAMM router — quote the candidate pool at the real clip size rather than assuming Uniswap wins.

## 6. Reading our own numbers (indexing skill)

- Historical reads come from an indexer, never a request-time log scan. `eth_getLogs` is span- and
  count-capped on public RPCs.
- Contracts should be event-first: every state change emits what the read side needs. Our ledger is
  offchain, so the equivalent rule is: keep `/api/stats/public` derived from stored rows, never from a
  live scan.
- Current state (balances, allowances) is a direct call batched through Multicall3 — not indexing work.
- For tokenized metrics, commit a **hash** of the series onchain and serve the detail offchain. A signed
  snapshot with the number in the clear invites back-dating arguments the hash avoids.

## 7. Frontend bar for the deposit page (qa + frontend-ux skills)

- Disconnected state shows a Connect button, not instructions.
- Wrong network turns the primary action into "Switch to Base" — otherwise a user approves on the wrong
  chain and eats a silent wallet error.
- One primary action at a time (Connect → Switch → Approve → Deposit), button locked while the
  transaction is in flight, and failures surfaced in words rather than `console.error`.

Our deposit page currently shows a single address and a chain select with no wrong-network gating. That
is a real gap to fix before it takes public money.
