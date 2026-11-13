# Verification of the external security review

Checked 2026-11-09 against `main` at commit `3e781bf`. Every verdict below was reached by
reading the code, not by trusting the review's description of it. Where a claim could be
checked against a public source (a GitHub advisory or a pull request) the source was queried
directly.

The review is a static source inspection and says so itself. That framing is honest and
mostly accurate, but it was written without checking git history, so it reports one issue as
open that had already been fixed hours earlier, and it overstates one that barely applies to
how we deploy.

## Verdict summary

| ID | Severity claimed | Verdict | Notes |
|---|---|---|---|
| SEC-001 | HIGH | **Confirmed, exploitable** | Real gap in `/api/credits/payment-review`. Fixed on branch `fix/sec-001-payment-sender-ownership`, not deployed. |
| SEC-002 | HIGH | **Half stale, half real** | MCP side already fixed in `src/lib/ssrf.ts`. x402 ordering issue is real and still open. |
| SEC-003 | MEDIUM | **Real advisory, overstated risk** | Vite 5.4.21 is in affected ranges, but every relevant advisory is a dev-server or Windows issue. |
| SEC-004 | LOW | **Confirmed** | Raw SIWE message is logged on parse failure. Still open. |
| SEC-005 | P1 | **Partly valid** | The crypto is correct; the rotation and migration plan does not exist. |
| SEC-006 | P1 | **Confirmed** | No rate limit on `/api/auth/nonce` or `/api/auth/verify`. Still open. |
| SEC-007 | P1 | **Mostly already done** | Nonce, freshness and domain are bound. Chain ID is not, and the lenient parser skips freshness. |
| SEC-008 | P1 | **Confirmed** | No `.github`, so no CI, no static analysis, no dependency or secret scanning. |

## SEC-001, payment sender ownership. Confirmed and serious.

The review's description matches the code exactly, and the qualifier "newer" is the important
part: this is a regression introduced by the newer flow rather than something always broken.

- `src/routes/credits.ts` `/api/credits/deposit` has always passed `fromWallet: user.wallet`, so
  `verifyDeposit` refuses a stranger's transfer with `wrong_sender`.
- `/api/credits/payment-review` checks that the intent belongs to the caller, finds the inbound
  transfer to one of our receivers, and then values it, records it and, for a settlement
  stablecoin, releases spendable credit through `creditVerified`. It never compares `t.from` to
  the caller's registered wallet. `findIncomingTransfer` is not even given a sender to compare.

Because `payments` is first-claim-wins, an attacker who watches our receiver addresses can
claim an inbound transfer before the real sender claims it and take the credit. No exploit was
run against production, since that would need someone else's real transfer and would move
money; the gap is established by reading the route.

Fixed on branch `fix/sec-001-payment-sender-ownership` as `checkSenderOwnership`, a pure
function refusing a mismatched sender, an unreadable sender and an account with no registered
wallet, called before any write. Six tests, suite 183/183. Deliberately not deployed: it changes
which payments are accepted, so it is Sam's call.

## SEC-002, SSRF. The MCP half is stale, the x402 half is real.

- `src/lib/ssrf.ts` exists and is not a stub: it rejects loopback, private, link-local, reserved
  and metadata addresses, validates resolved IPs rather than hostnames, pins the resolved
  address through the socket's `lookup` hook so a second DNS answer cannot redirect it, and
  re-validates every redirect in `guardedFetch`. It is applied at `src/agents/mcp.ts:59` and
  `:92` and at `src/agents/runner.ts:296` for `http_fetch`. The review's "no evident
  destination policy" is out of date.
- The x402 claim is correct and still open. `src/agents/x402.ts:52` performs `fetch(url, init)`
  before the allowlist gate on line 55, and `paidFetch` never calls `assertPublicUrl` at all. So
  the unpaid probe can reach an internal address, and the allowlist only governs payment. The
  ordering is defensible for pricing (a 402 must be seen to know the cost) but the probe itself
  needs the same destination policy.

Recommended fix: run `assertPublicUrl` inside `paidFetch` before the first request, keeping the
allowlist where it is. Small, testable, no behaviour change for legitimate sellers.

## SEC-003, Vite. True advisory, wrong risk for us.

Installed: `vite@5.4.21`, declared `^5.4.0`. Queried the GitHub Advisory Database directly:

- GHSA-9jrq-w75r-8gcw (low), GHSA-rq7h-c2jc-7f22 (medium), GHSA-r825-w8mm-5pxw (medium) and the
  `launch-editor` family including GHSA-587h-7wmj-h5pm (high) all list ranges that include
  5.4.x, so the version claim is accurate.

But every one is a `server.fs` or `launch-editor` issue: it requires the Vite dev server, and the
high-severity ones are Windows-only. Production serves a static build produced by `vite build`,
so our exposure needs someone running the dev server locally. Worth upgrading; not a production
risk, and not worth a rushed three-major jump.

PR #12 does exist, open, "Bump the npm_and_yarn group across 1 directory with 2 updates",
touching `package.json` and `package-lock.json`. The review says it goes to 8.3.6. That is a
three-major jump on the build tool, so it should be merged on the strength of a production
build, not on the strength of the advisory.

## SEC-004, SIWE logging. Confirmed, small.

`src/routes/auth.ts:50` and `:60` log `JSON.stringify(message.slice(0, 500))`. The message
contains the address, nonce, domain and URI. It does not contain the signature, so this leaks
identity and a nonce rather than credentials, and the nonce is deleted as soon as it is used.
Fix is to log a code and the domain.

## SEC-005, BYOK encryption. The primitive is fine, the lifecycle is missing.

`src/lib/env.ts:73-76` uses AES-256-GCM with a fresh `randomBytes(12)` IV per record and stores
the auth tag alongside the ciphertext, which is correct. What does not exist is any documented
`MASTER_KEY` rotation or migration path, and no test covers decryption failure. That is a
process gap, not a vulnerability, and the review is right to ask for it.

## SEC-006, authentication abuse. Confirmed.

No rate limiting appears anywhere in `src/routes/auth.ts`. `/api/auth/nonce` writes a row per
call, so it is both an unbounded-growth vector and a cheap way to make the nonce table large.
Signature verification makes brute force impractical, but the endpoint is unprotected.

## SEC-007, SIWE hardening. Mostly already done.

Already present: a 32-hex single-use nonce issued server-side, deleted on use; a ten-minute
`issuedAt` window; and a domain check against the request host. Missing: chain ID binding, and
the lenient parser at `src/routes/auth.ts:60` rebuilds `{ address, nonce, issuedAt: '' }`, which
means a lenient-parsed login skips the freshness check entirely. Replay is still bounded by the
single-use nonce, so this is medium rather than high.

## SEC-008, CI. Confirmed, and the largest structural gap.

There is no `.github` directory. No CI, no typecheck gate, no test gate, no dependency
scanning, no secret scanning, no lockfile check. Everything in this repository, including the
183-test suite, runs because a person chose to run it.

## What the review missed

These were already known here and are not in the document:

- **No payment finality or reorg handling.** Nothing in `src/payments` tracks confirmations,
  so credit can be issued against a transaction that later disappears. Related: the caller's
  session wallet is treated as proof of payment rather than a signed payer authorisation.
- **PGlite silently substitutes for Postgres.** `dbMode()` in `src/db/index.ts` returns
  `pglite` whenever `DATABASE_URL` is absent, so a production misconfiguration would boot
  happily onto a local embedded database and lose data instead of failing loudly.
- **No structured audit log with correlation ids**, which matters more now that money paths are
  being added.
- **No smart-contract surface review**, correctly, because none is deployed yet.

## Recommended order

1. Deploy the SEC-001 fix after Sam's approval. It is the only finding being exploited by
   reality rather than by a hypothetical.
2. Fix the x402 probe ordering, which is a ten-line change reusing an existing guard.
3. Add CI (SEC-008) before more money paths land, since every later fix is safer with a gate.
4. SIWE logging (SEC-004) and auth rate limits (SEC-006), together, one small pass.
5. Chain ID binding and the lenient-parser freshness hole (SEC-007).
6. Vite upgrade (SEC-003) on the strength of a production build, not the advisory alone.
7. `MASTER_KEY` rotation documentation (SEC-005) alongside the finality work.
