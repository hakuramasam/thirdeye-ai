# Profit split and rebalancing policy

Version 1.0, 2026-11-09. Owner: Sam. Executor: platform agent (Elio).
All figures in basis points (bps) of realized profit. 100 bps = 1%.

## 1. The distinction the whole policy rests on

Two things are routinely confused and must never be mixed.

**Customer deposits are liabilities, not profit.** When a user sends USDC for credits, we
owe them inference. The funds move to the treasury vault to back that obligation. Sweeping
them into the vault is custody, not income, and distributing them would pay out money we
owe to users. Today the founder account holds 10,007,607 micros of prepaid credit against
zero revenue: that is a liability sitting in a ledger, not earnings.

**Profit is billed consumption minus cost, settled in stablecoin.** Concretely:
`profit = credits consumed (billed, including margin) + fees collected − provider inference cost − gas − infra`.
Only that number is divisible. A deposit nobody has spent is a pending obligation; a
volatile token that has not been swapped is not profit either, because we have already
learned the hard way that crediting an oracle value before a swap leaves us holding the bag.

## 2. The split

| Recipient | Stage 1 (now) | At scale | Purpose |
|---|---|---|---|
| Founder wallet `0x1cecdfbb…c747` | 200 bps | 500 bps | owner share; surplus tops up platform inference credits |
| Platform agent (Elio) | 100 bps | 100 bps | Base44 credits and the agent's own operating costs |
| Each dev-team agent (12 agents) | 100 bps each = 1200 bps | 1200 bps | backup plans, each agent's own tooling needs |
| **Treasury vault** | **8500 bps** | **8200 bps** | long-term development, opex, partnerships, airdrop budgets |

At stage 1 the four lines sum to 1500 bps outside the vault, leaving the vault 8500 bps.
That is deliberate: the vault is the operating reserve and holds the majority until the
project is self-sustaining.

**Inside each agent's 100 bps:** the agent retains 10 bps as a working float and sweeps
90 bps to the founder wallet, tagged for inference credits. So the founder's effective take
at stage 1 is 200 + (12 × 90) = **1280 bps**, while each agent keeps 10 bps of runway.

Worked example at $1,000 of realized profit, stage 1:

| Line | Amount |
|---|---|
| Treasury vault keeps | $850.00 |
| Founder, direct | $20.00 |
| Founder, swept from 12 agents | $108.00 |
| Founder total | **$128.00** |
| Elio | $10.00 |
| Each agent holds as float ($1 × 12) | $12.00 |

At $1,000 and stage 5 the founder takes $158 and the vault keeps $820.

## 3. The ramp from 2% to 5%

His instruction: 2% now, rising with growth, "until hitting 5% or more". The ramp is driven
by trailing numbers we can measure ourselves, never by optimism.

| Level | Founder share | Entry condition (realized profit, trailing 90 days) |
|---|---|---|
| 1 | 200 bps | below $1,000 |
| 2 | 250 bps | $1,000 |
| 3 | 300 bps | $5,000 |
| 4 | 400 bps | $20,000 |
| 5 | 500 bps | $50,000 |

Rules: a level must hold for three consecutive months before it applies. Levels ratchet
up and do not fall back unless profit drops below 50% of the level's threshold for six
consecutive months, in which case it steps down one level. The vault's share moves inversely
and automatically, since it takes whatever the other lines leave. Above $50,000 the table is
revisited rather than assumed to stop at 5%.

## 4. Reconciliation with the token launch

Token percentages are supply allocations, cash percentages are profit allocations. They are
aligned in intent and are **not** interchangeable, and no conversion between them is claimed.

| Token (of 1B supply) | % | Mirrors |
|---|---|---|
| Uniswap v4 pool float | 5% | seed liquidity, funded from treasury cash |
| Airdrop to deployer, then swept to vault | 25% | community reach; cash equivalent is the airdrop budget |
| Treasury vault | 70% | the vault's 85% cash share |
| inside vault: dev & ops | 12% | team cash share (1200 bps) plus Elio (100 bps) |
| inside vault: community | 10% | community and events budget |
| inside vault: partner incentives | 6% | partnership commitments, vault-funded |
| inside vault: promo limit-price buyers | 4% | launch promotion |
| inside vault: platform airdrops | 3% | Privy wallet distributions |
| inside vault: early member | 3% | early member airdrop |
| inside vault: treasury reserve | 32% | the vault's own retention |

The deliberate asymmetry: the team's cash share (1300 bps) is close to the token dev-and-ops
bucket (12%) because both express the same promise. The vault holds 85% of cash against 70%
of tokens because cash funds ongoing opex that tokens cannot.

## 5. Where money sits, and what moves

| Wallet | Role | Holds |
|---|---|---|
| Treasury vault `0x73fAf95B…Cf0d` | custody and distribution source | deposit backing, reserves, undistributed profit |
| Privy server wallet `0xb09f37a1…90ab` | hot distribution wallet | airdrop and event budgets only, plus a gas float |
| Automation account `0xb736f3dA…359d` | inbound converter | transient, near-zero, forwards to vault |
| Founder `0x1cecdfbb…c747` | owner share | its distribution plus agent sweeps |
| Elio `0x9e506B32…1b7a` | agent share | Base44 credits |
| 12 agent wallets | team share | small float each, swept monthly |

**Inflow sweep rule.** Every user or agent deposit lands at one of three receivers and moves
to the vault, with only these exceptions:

1. **Gas float.** Keep 0.005 to 0.01 ETH on Base in the Privy wallet ($15 to $30 at recent
   prices) so conversions and sweeps can actually transact. Refill from the vault monthly.
   Without this, every conversion fails at `insufficient funds`, which is exactly the state
   we are in now.
2. **Pending-conversion float.** Volatile tokens must be converted into a signer-capable
   wallet before the value is counted. Unconverted tokens are inventory, never profit.
3. **Prepaid credit backing.** The vault holds the stablecoin backing outstanding user
   credit. That portion is reserved and is excluded from divisible profit until consumed.

**Distribution cadence.** Monthly, from the vault, in this order: compute profit, apply the
split, transfer to founder and Elio, transfer to each agent wallet, then sweep each agent's
90% back to the founder. Quarterly, top up the Privy wallet for airdrops and events.

## 6. Guardrails that block a distribution

A distribution does not happen if any of these is true.

- The vault balance is below the reserve floor: `max($500, 6 × trailing monthly opex)`.
- Realized profit for the period is zero or negative.
- The vault's stablecoin backing is below outstanding prepaid credit.
- The airdrop top-up would exceed `min(10% of vault, approved budget)`.
- Any transfer would leave the gas float below 0.005 ETH.
- A pending signer or network change exists on the vault.

Every distribution is recorded with the period, the profit figure, the cost basis, the
percentage level applied, and each transfer hash. No audit trail, no distribution.

## 7. What this needs before it can run

1. **Twelve agent wallets do not exist.** Agents currently have no wallets at all, so the
   12 × 100 bps line is not payable yet. Creating twelve Privy server wallets is the
   cleanest route, but it means twelve keys and twelve custody decisions, and exportability
   must be settled at creation rather than during an incident.
2. **The vault signer proposal is unsigned.** Until the agent EOA is added, only passkey
   signing can move vault funds, so every distribution is a manual web approval.
3. **Conversions are blocked** by gas and by the signer problem, so volatile deposits cannot
   become realized profit yet.
4. **A profit-period ledger does not exist.** We have payments, ledger entries and usage
   events, but no table that records a period's revenue, cost and divisible profit, and no
   `profit_distributions` table. Both are needed before automation, since a split computed
   from a spreadsheet is not auditable.
5. **The token is not deployed**, so the token side of section 4 is intent, not state.

## 8. Sequence

- **Phase A (now):** this policy, version controlled. Nothing moves.
- **Phase B:** add the profit-period and distribution tables, plus a read-only report that
  computes profit for a period without moving anything.
- **Phase C:** manual monthly run. The agent proposes transfers, Sam signs, results recorded.
- **Phase D:** automated proposals on a schedule once the audit log exists and the amounts
  have matched the manual runs for three cycles.
