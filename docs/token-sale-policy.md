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
3. **The binding minimum for any sale is the higher of the $50,000 floor and the post-bonus deposit credit
   value.** Deposits credit THIRDEYE at the live policy rate plus the live deposit bonus, which today is
   $0.00008 x 1.1 = **$0.000088 per token** ($88,000 FDV). A buyer who pays less than that and deposits
   gets back more credit than the token cost, so selling anywhere in the $50,000 to $88,000 band is
   refused too, on every venue, not just quoted against. The $50,000 floor only becomes the binding
   number if the credit rate falls below $0.00004545, where rate x 1.1 slips under $0.00005.

| level | USD per token | FDV at 1B | meaning |
| --- | --- | --- | --- |
| hard floor | 0.00005 | $50,000 | Sam's floor: no sale recorded below this, ever |
| binding minimum, today | 0.000088 | $88,000 | the post-bonus credit value, so no free-credit loop |
| curve implied, 2026-11-16 | 0.0000988 | $98,800 | where the launch curve sits, reference only |

The binding minimum moves with the deposit settings, so it is recomputed from them rather than read off
this table: `rate x (1 + bonusBps / 10000)`, never below the floor.

### The deposit settings this depends on

Read live from production `/api/me` on 2026-11-16, which returned
`platform_token: {live: true, priced: true, usd_rate: 0.00008, bonus_bps: 1000, max_deposit_usd: 25}`
for `0xa8a65a86e01d227dbfd7c7a94d14344b33603df5` on Base:

| setting | env var | production value | repository default |
| --- | --- | --- | --- |
| policy rate | `PLATFORM_TOKEN_USD_RATE` | 0.00008 | 0 |
| deposit bonus | `PLATFORM_TOKEN_BONUS_BPS` | 1000 | 0 |
| per-deposit cap | `PLATFORM_TOKEN_MAX_DEPOSIT_USD` | 25 | 25 |

Those live in the deployment environment, not in the repository, and the defaults are zero: with no rate
published the deposit path refuses to value the token at all rather than crediting an unvalued amount. So
this policy has to be read against the live configuration, and whoever changes the rate or the bonus
changes the binding minimum at the same time. The deposit cap does not rescue a bad sale price: it limits
how much credit one deposit can buy, not whether the token was sold below its credit value.

## What must be true before any sale

Supply is **1,000,000,000**, read from `totalSupply()` on the token at block 58,139,747, and
every figure in this policy uses that denominator. `docs/tokenomics.md` still carries an abandoned
100B Clanker shape and now says so at the top; where the two disagree, the chain and this document
are correct.

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
