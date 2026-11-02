# THIRDEYE tokenomics

Launch venue: Clanker v4 on Base (ERC-20 + Uniswap v4 pool in one transaction).
Supply is **fixed by the venue at 100,000,000,000 (100B)**, 18 decimals, no mint function. Clanker does
not accept a custom supply, so "1B" cannot be carried over as-is; the economics are identical at 100x
scale. All figures below are percentages, which are supply-agnostic.

## Allocation of total supply

| Bucket | % | Tokens (100B) | Where it lives | Unlock |
| --- | --- | --- | --- | --- |
| Liquidity pool | 60% | 60.00B | Uniswap v4 THIRDEYE/WETH, LP locked by Clanker | liquid at launch |
| Dev & operations | 12% | 12.00B | Splits Split, bucket 1 | 6-month cliff, 24-month linear |
| Community rewards | 10% | 10.00B | Splits Split, bucket 2 | 6-month cliff, 24-month linear |
| Partner incentives | 6% | 6.00B | Splits Split, bucket 3 | 6-month cliff, 24-month linear |
| Promo: limit-price package buyers | 4% | 4.00B | Splits Split, bucket 4 | 6-month cliff, 24-month linear |
| Platform airdrops (Abund.ai + future) | 3% | 3.00B | Splits Split, bucket 5 | 6-month cliff, 24-month linear |
| Early member airdrop | 3% | 3.00B | Splits Split, bucket 6 | 6-month cliff, 24-month linear |
| Ops float (immediately available) | 2% | 2.00B | treasury, via Clanker airdrop extension, zero lockup | **immediate** |
| **Total** | **100%** | | | |

Onchain split of the same numbers, which is what the deploy actually encodes:

- **Extensions 40%** (Clanker max 90%): `vault` = 38% to the treasury Split, `airdrop` = 2% to the
  treasury with zero lockup.
- **Pool 60%** (Clanker minimum 10%).
- Pool trading fees: **100% to the treasury vault**, paid in the paired token (WETH) rather than in
  THIRDEYE, so fee income is not self-referential.
- No dev buy, no insider purchase at deploy, vanity address off.

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

## Bucket custody on Splits

Splits 0.5.0 exposes accounts, not arbitrary percentage Split contracts: the org root owns the
treasury, and the treasury owns subaccounts. So bucket attribution uses **one subaccount per bucket**
under the treasury vault, and every payout is a transfer with a visible tx.

The 38% vault tranche is paid to the treasury itself, then routed to bucket subaccounts on the same
schedule. Subaccount creation under the treasury is a treasury-authorised action, so it needs Sam's
passkey, not the agent key.
