# Development assessment, 2026-11-09

A measured review of where the Thirdeye AI development team actually stands, what shipped today,
who shipped it, and what is still broken. Every figure here comes from the production database,
the repository or the live deployment, not from notes.

## 1. The team, measured

Twelve agents are registered and all twelve are `status=active` with `repo_access=read`.

| Agent | Model | Budget (micros) | Steps | Ever ran |
|---|---|---|---|---|
| HERMES (orchestrator, delegates) | gpt-oss-120b | 12,000 | 6 | yes, 4 runs |
| ARCHITECT | gpt-oss-120b | 40,000 | 5 | yes, 2 runs |
| SENTINEL | gpt-oss-120b | 40,000 | 5 | yes, 1 run |
| QA | ministral-3b | 15,000 | 4 | yes, 4 runs |
| DOCS | ministral-3b | 15,000 | 4 | yes, 2 runs |
| PRODUCT, BACKEND, FRONTEND, BLOCKCHAIN, INTELLIGENCE, DEVOPS, AGENT-ENGINEER | mixed | 15-30k | 4 | **never** |

The whole ledger holds 13 runs, 10 of them today. Total spend today is 9,743 micros, about one
cent. The last team run was 11:39 UTC.

Two facts that matter more than the roster:

1. **No agent has ever authored a commit.** Every commit in the repository is mine. The team has
   not written a line of production code, a test, or a migration.
2. **Seven of twelve have never executed once.** The roster is tiered and configured, but the
   tiering is unexercised apart from QA and DOCS on the cheap model.

The `agent_schedule_lock` table holds a single row, from an idempotency probe. The daily
orchestrator schedule is therefore not producing a working cadence; team activity so far has come
from manual ops triggers, not from a pipeline.

## 2. Why the team cannot do the job it was named for

This is structural, not a performance problem. The runner gives an agent exactly two tools plus
whatever `repo_access` unlocks:

- `http_fetch`
- `delegate_to_agent` (HERMES only)
- `repo_read` when `repo_access` is `read`: list, read, search, capped at 20k characters per read,
  refusing secret-shaped paths and traversal.

There is no write, no branch, no shell, no test runner, no deploy. An agent can read `runner.ts`,
quote it verbatim, and describe a fix. It cannot commit that fix, cannot run the suite to prove it,
and cannot ship it. So "fixing issues and building" is not something the current team is equipped
to do at all, and the lack of output is the design working as built rather than agents failing.

A second consequence, visible today: because they cannot see git history, ARCHITECT and SENTINEL
spent their first real mission re-deriving two designs that had already shipped hours earlier (the
MCP SSRF guard and durable cron locking). Competent output, partly redundant work, for under a
cent. That is the shape of a reader without history.

## 3. What actually shipped today, and by whom

| Workstream | Status | Done by |
|---|---|---|
| Security review verification (8 findings, evidence per finding) | shipped as docs | me |
| SEC-001 payment sender ownership (exploitable) | shipped, live | me |
| SEC-002 x402 destination policy | shipped, live | me |
| SEC-003 Vite 5 to 8.3.7, deps refreshed (Dependabot 32 to 8) | shipped, live | me |
| SEC-004 SIWE log redaction | shipped, live | me |
| SEC-005 BYOK key rotation, versioned ciphertext, docs | shipped, live | me |
| SEC-006 auth rate limits and nonce hygiene | **partial, uncommitted, untested** | me |
| SEC-007 SIWE chain ID binding and lenient-parser freshness | not started | - |
| SEC-008 CI (typecheck, tests, audit, secret scan) | not started | - |
| Repo read tool, `repo_access` gate | shipped earlier today | me |
| Agent tiering | configured, mostly unexercised | me |
| Profit split engine and read-only report | shipped earlier today | me |

Suite is at 198 tests, all green as of the SEC-005 merge. Production health is 200. Production
commit is `db9088b`.

The honest summary: today's engineering output is mine. The team contributed two design documents
and a handful of QA/DOCS runs.

## 4. Bug and issue ledger

Open, ordered by what would hurt most:

| Issue | Severity | State |
|---|---|---|
| No payment finality or reorg handling; credit can outlive a transaction that disappears | high | open |
| PGlite silently substitutes for Postgres when `DATABASE_URL` is missing, so a misconfig loses data instead of failing loudly | high | open |
| Volatile deposits sit `pending_conversion` with no caller for settle: the gas wallet holds 0 ETH, so conversions are safe but frozen | high, business | blocker outside code |
| Two Accounts are credited in accounting but the settle step cannot sign: deposits land in a passkey-only vault we cannot move | high, business | blocker outside code |
| Streaming charges the estimate only, roughly 45% undercharge, because the true-up row never lands | medium | fixed in d5fb69a, measured |
| No structured audit log with correlation ids | medium, blocks autonomy | open |
| WalletConnect dependency cluster, 8 residual Dependabot alerts | low, accepted | documented |
| SEC-006/007/008 | medium | in progress |

Closed today and verified live: sender-ownership credit exploit, x402 probe SSRF, agent run
crash-safety and locking, MCP/http_fetch SSRF guard, stale running rows, Vite advisory range,
SIWE log leak, BYOK rotation gap.

Streaming reconciliation, closed 2026-11-11 in `d5fb69a` and measured on production: the cause
was `hono/vercel`'s `handle()` calling `app.fetch(req)` with no ExecutionContext, so
`c.executionCtx` threw and the accounting fell back to a promise Vercel froze away with the
response. Settlement is now a `TransformStream` the response is made of. A streamed call through
the production relay moved the public totals by exactly one request and 451 measured tokens, and
six tests assert the true-up row exists by the time the caller has read the last byte.

## 5. Assessment

**The team is a review instrument, not a development team.** It is genuinely good at: reading code
and quoting it accurately, producing structured designs, cheap enumeration of options, and QA-style
checking. It is structurally incapable of: writing code, running tests, committing, deploying, or
noticing that a problem was already fixed yesterday.

Three things follow.

1. **Do not staff build work against them yet.** Every "the dev team is fixing X" expectation will
   end with me doing it, so the honest framing is that I am the engineering capacity and they are
   the review layer. Cost is not the constraint: the entire team cost about a cent today.
2. **CI is the gate before any write access.** SEC-008 is the prerequisite for trusting agent
   output, because with typecheck, tests and a secret scan enforced on every push, a bad agent
   patch fails loudly instead of quietly. Without it, granting write access means reviewing every
   diff by hand forever, which is slower than writing the code myself.
3. **A cadence, not ad-hoc triggers.** 13 runs in a day, 7 of 12 agents idle, no schedule firing
   is noise pretending to be a pipeline. Either give them a real weekly brief with one owner per
   area, or stop paying for the roster. Ambiguity is the expensive option.

Recommended sequence to make the team productive rather than decorative:

1. Finish SEC-006, then SEC-007, then SEC-008 (CI). CI last is what Sam asked for, but it is the
   item that unlocks everything after it.
2. Add the audit log with correlation ids.
3. Give write access as **branch plus pull request only**, never to `main`, and only once CI is
   required on the branch.
4. Then hand one narrow, non-money task to BACKEND or FRONTEND end to end and measure whether a
   reviewable PR comes back. If it does, expand. If it does not, the roster stays a review layer.
