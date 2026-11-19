# BaseScan token information application: THIRDEYE

Prepared 2026-11-17. This is the submission text for BaseScan's manual token-information route, because
the self-serve *Update Token Info* flow cannot be completed for this contract (see the last section).

Every value below was read from the chain or from a live public endpoint, not from memory.

## Subject token

| Field | Value |
| --- | --- |
| Name | Thirdeye |
| Symbol | THIRDEYE |
| Chain | Base (8453) |
| Contract | `0xA8A65A86E01D227Dbfd7C7a94d14344b33603df5` |
| Total supply | 1,000,000,000 (fixed, no mint function) |
| Decimals | 18 |
| Launch transaction | `0x66e65f6e49bf08a34cbc703df9ae6b2d4fd983a2a2068340a17a53b93589ead2` |
| Launch block and time | 56,365,145, 12 Nov 2026 06:03:24 UTC |
| Launch platform | Doppler (DopplerHookInitializer `0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544`) |
| Pool | Uniswap v4 pool `0x6309d838712108206856c9ce1ab743c8f50863b9b4c4389c828fe1c950256066` (THIRDEYE/WETH, 0.3%) |
| Launch transaction sender | `0xb09f37a1110a126d63463Ec08a0C0B97612D90ab` (a wallet, but not the contract creator) |
| Contract creator | No wallet. ERC-1167 clone created inside the launch transaction by Doppler token factory `0xf1542Dd2D46394C16372FB00f2c339b53CeF2cE5` |

## Listing fields to submit

| Field | Value |
| --- | --- |
| Project name | Thirdeye AI Platform |
| Official website | https://thirdeye-ai-alpha.vercel.app |
| Whitepaper | https://thirdeye-ai-alpha.vercel.app/whitepaper |
| Contact page | https://thirdeye-ai-alpha.vercel.app/contact |
| Official email | thirdeye-ai@agentmail.to |
| X | https://x.com/Thirdeye_Infra |
| Telegram | https://t.me/Thirdeye_AI_Bot |
| Abund.ai agent | https://abund.ai/agent/thirdeye |
| Source repository | https://github.com/hakuramasam/thirdeye-ai |
| Logo, 512x512 PNG | https://gateway.pinata.cloud/ipfs/QmPhbBSHrtL8G8YAMcyTYYD3i7mtcoTWCvBNQXm6r3tYcA |
| Banner, 1600x466 | https://gateway.pinata.cloud/ipfs/QmYCgiEpfWNsj38zTk6m3vwh4ADotru1H7ykyqfHk4a8ba |
| Logo, 32x32 PNG (explorer size) | https://gateway.pinata.cloud/ipfs/bafkreie6fvwfncjbjcrllbqzculjxqpu7nw7hcrlnwvmt447azcr4q3nne |
| Logo, 32x32 SVG (explorer size) | https://gateway.pinata.cloud/ipfs/bafkreievqluyhkk3vopa55ulkwe2qp2gx3cr6j6ukqziasduybmhw5hf4y |
| Description | Thirdeye AI Platform is an OpenAI-compatible inference API with wallet-native accounts, prepaid credits and metered billing. THIRDEYE is the platform token: it is accepted as a credited deposit at a published policy rate, so holders can convert it into inference credit on the platform. |

## Before submitting

Submit only once the site change that publishes these channels on `/contact` is deployed to production.
A reviewer following this application to a stale `/contact` page cannot confirm the Telegram and Abund
handles, and an application that fails that check is worse than one sent a day later.

## Why the self-serve flow cannot be used

BaseScan's self-serve *Update Token Info* sits behind **Verify Address Ownership**, which requires a
signature from the address that created the smart contract. This token is not deployed by our wallet: it
is an ERC-1167 clone created inside the launch transaction by Doppler's token factory, so the creator
address on record is a contract that cannot sign a message. The Privy signer that sent the launch
transaction is not the contract creator and therefore cannot satisfy the check either. The contract's own
`owner()` is the Doppler Airlock, and `tokenURI()` returns an empty string, so no metadata can be written
onchain by us, now or later.

That is why this application goes through the manual review route, with the launch transaction and the
pinned IPFS bundle above as proof of authorship.

## Supporting evidence a reviewer can check independently

- The launch transaction receipt shows the factory call that produced the token address.
- `totalSupply()` returns 1e27 and `tokenURI()` returns an empty string, on any Base RPC.
- The pool has traded: the first swap is transaction
  `0xc53d51fc1bf30ed7a0f59eecbbc6ed91fdee2e6614b9e19576e45e7c3a8ff1e4` on 17 Nov 2026, so the pair is
  indexed by DexScreener and GeckoTerminal rather than sitting as an untraded launch.
- The same token, pool, hook, factory, launch, first-swap and asset values appear on the project's own
  /contact page, so the listing can be cross-checked against the project rather than trusted from this
  document. The 32px icons and the description above are the only fields here that /contact does not carry.
