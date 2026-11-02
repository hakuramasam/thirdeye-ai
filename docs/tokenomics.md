# THIRDEYE tokenomics

Launch venue: Clanker v4 on Base (ERC-20 + Uniswap v4 pool in one transaction).
Supply is **fixed by the venue at 100,000,000,000 (100B)**, 18 decimals, no mint function. Clanker does
not accept a custom supply, so "1B" cannot be carried over as-is; the economics are identical at 100x
scale. All figures below are percentages, which are supply-agnostic.

## Allocation of total supply

| Bucket | % | Tokens (100B) | Unlock schedule |
| --- | --- | --- | --- |
| Liquidity pool | 60% | 60.00B | liquid at launch (Clanker LP lock) |
| Dev & operations | 12% | 12.00B | 6-month cliff, then 24-month linear |
| Community rewards | 10% | 10.00B | 1-month cliff, then 6-month linear |
| Partner incentives | 6% | 6.00B | 1-month cliff, then **fully unlocked** |
| Promo: limit-price package buyers | 4% | 4.00B | 1-month cliff, then **fully unlocked** |
| Platform airdrops (Abund.ai + future) | 3% | 3.00B | 1-month cliff, then **fully unlocked** |
| Early member airdrop | 3% | 3.00B | 1-month cliff, then 12-month linear |
| Ops float | 2% | 2.00B | **immediate at token creation** |
| **Total** | **100%** | **100.00B** | |

### What is liquid, and when

| Time | Cumulative liquid | From where |
| --- | --- | --- |
| day 0 | 2.00B (2%) | ops float, delivered at deploy |
| day 30 | 15.00B (15%) | partner 6% + promo 4% + platform airdrops 3% + ops 2% |
| day 30 onward | +55.6M/day | community rewards (10B over 6 months) |
| day 30 onward | +8.2M/day | early member airdrop (3B over 12 months) |
| day 180 | +16.4M/day | dev unlocks begin (12B over 24 months after the cliff) |
| day 210 | community fully released | |
| day 365 | early member fully released | |
| day 810 | dev fully released | |

### How the venue actually enforces this

Clanker allows **one** vault with a single cliff and a single linear vesting period, so six different
schedules cannot be encoded at deploy. The schedule above is therefore built in two layers:

1. **Clanker deploy**: `vault` = 38% to the treasury, **1-month cliff, zero linear vesting** (the whole
   38% becomes claimable on day 30). `airdrop` extension = 2% to the treasury with **zero lockup**,
   which is the day-0 ops float.
2. **Sablier streams created immediately after deploy**: each bucket gets its own LockupLinear stream
   from the treasury with the cliff and duration in the table above. The 38% arrives at the treasury on
   day 30 and is already committed to those streams, so each bucket still releases exactly on its own
   schedule.

Layer 2 is a real onchain commitment, not a promise in a document: a Sablier stream cannot be
un-created, redirected, or accelerated by the platform. The one honest tradeoff is that the tokens
physically sit in the treasury between day 0 and day 30 before they enter their streams, whereas a
custom contract could have locked each bucket separately from block one. Given the cost of hand-rolling
and auditing that, this is the better trade.

## The honest answer on "is 5% dev enough?"

5% of 100B is 5B tokens, which sounds enormous and is worth almost nothing at launch. Sizing a bucket
in tokens hides the only question that matters: what is it worth, and what does it buy?

If launch FDV is set at 15 ETH (about $60k at ETH $4,000), then:

| Bucket | % | USD value at 15 ETH FDV |
| --- | --- | --- |
| Dev & operations | 12% | ~$7,200 |
| Community rewards | 10% | ~$6,000 |
| Partner incentives | 6% | ~$3,600 |
| Promo bonuses | 4% | ~$2,400 |
| Platform airdrops | 3% | ~$1,800 |
| Early member airdrop | 3% | ~$1,800 |
| Ops float | 2% | ~$1,200 |

So the entire 40% non-pool side is worth roughly **$24,000 of illiquid paper at launch**, and every
dollar of it requires a buyer. Conclusion to state plainly: **the token does not fund development.**
Credits revenue funds development. The token's job is to give users a settlement asset and give
contributors a claim on a growing network, not to be the treasury.

That is why dev is 12% and not 30%: the allocation is a gesture toward alignment, not a funding round.
Raising it further would only dilute the people the buckets exist to reward, without producing any
spendable money.

## Why these percentages

- **60% to the pool** is the float. With no capital of our own to seed liquidity, a wide float at a low
  unit price is what makes the token buyable at small ticket sizes without moving it.
- **12% dev and ops** covers audits, tooling, RPC and infra for roughly two years of grants, none of it
  sellable in month one because of the cliff.
- **10% community rewards** is the largest behavioural bucket: paid for usage and contributions, not
  handed out. It is the only bucket that can grow the actual product.
- **6% partners** funds integration incentives for platforms that route payments through Thirdeye.
- **4% promo** is deliberately capped: a limit-price bonus programme that pays in a token with no
  market depth can turn into a liability if it is generous. 4% is enough to run it, small enough to
  stop it.
- **3% platform airdrops and 3% early members** are marketing spend denominated in the thing being
  marketed. Kept small because airdrops to people who do not use the product buy nothing.
- **2% immediate float** is the only liquid slice, and it is small on purpose: it pays for the first
  listings, the first integrations, and the mistakes nobody plans for.

## Distribution mechanics

1. Split contract (Splits.org) holds the 38% vault tranche with the six bucket percentages encoded.
   Changing a percentage is a signed change, not an edit in a spreadsheet.
2. Vault unlocks linearly after the 6-month cliff; whatever arrives is claimed by the Split and
   attributed to buckets automatically.
3. Every bucket payout is recorded in Splits' own transaction history, which is the audit trail we
   point at when someone asks where the tokens went.
4. No bucket is sold by the platform into its own pool. If a bucket needs dollars, it is sold OTC with
   a stated price and a public tx, or not at all.

## What this plan deliberately does not do

- No private sale, no pre-sale, no whitelist raise.
- No yield, staking APR, or "buy to earn" framing, since those are the exact features that turn a
  utility token into something requiring legal advice first.
- No burn mechanic that pretends to create value by shrinking a supply nobody is buying.
- No allocation that requires trusting a spreadsheet: every number above is enforced by the Split
  contract or by Clanker at deploy time.

## Custody and authority

- Vault tranche recipient: the Splits treasury vault. Release on day 30 is a treasury-authorised claim,
  signed by Sam's passkeys. The agent proposes, Sam signs.
- Bucket streams: Sablier LockupLinear contracts on Base, created right after deploy, one per bucket.
  Their release schedules are immutable once created.
- Bucket attribution beyond the streams (which address a community reward is paid to, for example) is
  recorded in Splits subaccounts and in the platform ops ledger, so every payout has a tx to point at.
