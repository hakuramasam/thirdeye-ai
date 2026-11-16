# THIRDEYE sale policy

Rule of record for selling the platform token. Adopted 2026-11-16 on Sam's instruction, replacing the
earlier proposal (a $1M FDV floor and a six-month waiting period) that was never approved and never
written down here.

Related: [token launch pipeline](token-launch-plan.md), [tokenomics](tokenomics.md),
[token playbook](token-playbook.md).

## The rule

1. **No sale below $50,000 FDV.** At 1,000,000,000 supply that is **$0.00005 per token**, in USD terms,
   whatever the quote currency. No transaction, OTC or pooled, is recorded at a lower valuation.
2. **Sales are permitted from adoption.** The "no sales before month six" condition is deleted: no
   waiting period, no minimum token age, no calendar gate.
3. **The asking price is $0.000088 per token or higher ($88,000 FDV).** Deposits credit THIRDEYE at the
   ops policy rate (`PLATFORM_TOKEN_USD_RATE`, $0.00008 today) plus the 10% deposit bonus, so a
   deposited token is worth $0.000088 of platform credit. A sale below that value hands the buyer a
   positive loop: pay $0.00005, deposit, receive $0.000088. Quoting the pre-bonus rate ($0.00008) still
   leaves the 10% bonus as free credit, so the guard is the post-bonus figure, not the rate. The $50,000
   floor is the hard stop; $0.000088 is what is actually asked.

| level | USD per token | FDV at 1B | meaning |
| --- | --- | --- | --- |
| hard floor | 0.00005 | $50,000 | no sale recorded below this |
| asking price | 0.000088 | $88,000 | at the post-bonus deposit credit value, so no free-credit loop |
| curve implied, 2026-11-16 | 0.0000988 | $98,800 | where the launch curve sits, reference only |

If the ops credit rate or the deposit bonus changes, the asking price moves with it: rate times one
plus the bonus, and never below the $50,000 floor.

## What must be true before any sale

Verified onchain 2026-11-16 at block 58,139,747:

- The treasury vault `0x73fAf95B2Baa23bde4CE8547b64C55159022Cf0d` holds **0 THIRDEYE**. The
  800,000,000 premint sits in the token contract behind immutable cliffed schedules; the earliest
  release is the 110,000,000 bucket on **2026-12-12 12:33 Myanmar time**. There is no admin unlock,
  re-schedule or rescue function.
- The v4 pool holds 200,000,000 THIRDEYE against a **zero quote side**, so there is no counterparty and
  a pooled sale returns nothing at any FDV.
- `totalSupply` is 1,000,000,000, there have been no swaps, DexScreener has no pair and GeckoTerminal
  reports no price.

So no sale is executable today. The earliest possible sale under this rule is after 2026-12-12, and it
has to be a direct sale to a named buyer, not a market sale.

## Carried over from the earlier proposal, still awaiting approval

Unchanged by the 2026-11-16 revision, and not in force until Sam approves them:

- Tranche cap of 0.5% of supply per rolling 30 days (5,000,000 tokens), 1% only above $5M FDV. At
  $0.000088 that caps a month at about $440.
- OTC only, with each transaction published.
- Quarterly recalculation as the greater of $50,000, 5x trailing-twelve-month platform revenue and 70%
  of the trailing 90-day average FDV.

## What this does not change

- No token is released, moved or authorised by this document. Transfers stay gated by the immutable
  onchain schedules, which no owner action can alter.
- The deposit credit rate, bonus and $25 per-deposit cap are environment configuration read by
  `src/payments/chains.ts`. This policy constrains the sale price, not the credit rate.
- Not an offer, not investment advice, and it creates no third-party right to buy at these prices.
