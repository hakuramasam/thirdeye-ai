// Generated from the real commit history of the public repository.
// Regenerate with: git log --pretty=%H|%ad|%s --date=short | head -24
// Kept as data rather than read at runtime because the serverless runtime has no git.

export type ChangelogEntry = { sha: string; date: string; summary: string }

export const CHANGELOG: ChangelogEntry[] = [
  { sha: "b81bcba", date: "2026-11-09", summary: "Add feedback intake, and finish SEC-006 auth abuse protection" },
  { sha: "dbb2e31", date: "2026-11-09", summary: "Give every agent a capability pack it can read at runtime" },
  { sha: "2fa2c02", date: "2026-11-09", summary: "Add the 2026-11-09 development assessment" },
  { sha: "cb48505", date: "2026-11-09", summary: "Close SEC-005: make BYOK key rotation real and document it" },
  { sha: "26288dc", date: "2026-11-09", summary: "Close SEC-004: stop logging the raw SIWE message" },
  { sha: "244a233", date: "2026-11-09", summary: "Close SEC-003: move Vite off the affected range and refresh runtime deps" },
  { sha: "014baf2", date: "2026-11-09", summary: "Close SEC-002: run the x402 destination policy before the unpaid probe" },
  { sha: "cd95497", date: "2026-11-09", summary: "Add the verification report for the external security review" },
  { sha: "334eb0b", date: "2026-11-09", summary: "Close SEC-001: bind payment-review credit to the sender's own wallet" },
  { sha: "3e781bf", date: "2026-11-09", summary: "Fix outstanding-credit sign error found by running the report live" },
  { sha: "9a0a328", date: "2026-11-09", summary: "Add profit-period and distribution tables with a read-only report" },
  { sha: "8617917", date: "2026-11-09", summary: "Add the profit-split and rebalancing policy" },
  { sha: "df39ad3", date: "2026-11-09", summary: "Give the agent function 60s instead of 30s" },
  { sha: "6f420c8", date: "2026-11-09", summary: "Close the two Sprint 1 gaps the team designed, and give agents read-only repo access" },
  { sha: "81e0ef4", date: "2026-11-09", summary: "Read a native send from the transaction itself, because it emits no Transfer log and was refused as wrong_recipient" },
  { sha: "93a9f6d", date: "2026-11-09", summary: "Resolve the chain from chain_id, because the payments table has no chain_slug and every non-Base row was read as Base" },
  { sha: "a134934", date: "2026-11-09", summary: "Route native deposits through Privy inside the real executor, not the unused helper, and allow BSC for natives only" },
  { sha: "b99801c", date: "2026-11-09", summary: "Convert native ETH and BNB through Privy's swap engine, so natives stop being priced and then refused at execution" },
  { sha: "08807a2", date: "2026-11-09", summary: "Track haku85 and AASA alongside TREND, with verified contract facts and the same conservative deposit gates" },
  { sha: "8115b10", date: "2026-11-09", summary: "Let the conversion signer pay gas through Privy sponsorship, walking app credits then USDC gas then plain ETH without retrying real refusals" },
  { sha: "a078dc7", date: "2026-11-09", summary: "Quote swaps straight from v3 pool state through QuoterV2 and route through SwapRouter02, so a conversion no longer depends on a vendor API key" },
  { sha: "d96d182", date: "2026-11-09", summary: "Privy: sign authorized calls with the key quorum's P-256 key over canonical JSON, and point conversions at the Thirdeye AI Platform wallet" },
  { sha: "3ae5239", date: "2026-11-09", summary: "Tracing: await the span with a bounded race, because a serverless function stops the moment the response returns" },
  { sha: "4156337", date: "2026-11-09", summary: "Telemetry: OTLP span export to Langfuse for every agent run, fire-and-forget so tracing can never fail a paid run" },
]

export const SUITE = { tests: 212, measuredOn: "2026-11-09", command: "npm test (PGlite, DATABASE_URL unset)" }
