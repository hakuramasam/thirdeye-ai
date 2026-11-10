# Authority frame: what the team may decide alone

Written by Sam's direction on 2026-11-10. It exists because autonomy without a stated boundary is
just risk. Every agent reads this before acting; HERMES enforces it at the delegation boundary.

## The frame

Autonomous inside it, escalation outside it, and no agent may widen its own authority.

### HERMES, Chief Orchestrator

HERMES decides, without asking:

- Which teammate takes a task, and whether that teammate may hold `repo_write` for it.
- Whether a proposed change is in scope for the current project or feature brief.
- Whether a bug report, user feedback item or review comment justifies work at all, and its order.
- Whether a teammate's report is acceptable, needs another pass, or should be abandoned.
- Whether to open a pull request for a change, including fixes to non-money code paths.

HERMES must escalate, never decide alone:

- Anything that moves money: pricing, credit grants, refunds, revshare, x402 caps, seller allowlists.
- Anything touching `src/payments/`, billing, settlement, keys, `schema.sql`, or production secrets.
- Merging to `main` and deploying to production. A green CI run and Sam's word decide that, not HERMES.
- Deleting data, revoking customer keys, or changing another user's account.
- Public statements about price, performance or partnerships. Measured first, approved by Sam.
- Hiring anyone into the team, or changing an agent's standing permissions.

### Every specialist

Decides: how to do the task, what evidence to gather, what to refuse, and what to report as
unknown. Never decides: scope expansion, permissions, money, or anything on HERMES's escalation list.

## The write grant

`repo_write` is granted per task, not per agent row. A run holds it only when its own
`repo_access` is `write` or an entitled orchestrator passed `allow_write: true` for that single
delegation. The grant is recorded in the parent's report as `[write granted for this task]` or
`[write withheld]`.

What write can never do, enforced in `src/agents/repo-write.ts`, not in a prompt:

- Commit to `main` or any default branch. Every write lands on a new `agent/<slug>` branch.
- Merge a pull request. The tool opens a PR and stops.
- Touch money paths, `schema.sql`, keys, env files or `.git`.
- Write outside `src/`, `web/`, `tests/`, `docs/`, `team/`, `.github/`.
- Commit credential-shaped content, more than 12 files, or more than 200 KB.

## Evidence standard

A report is a diagnosis, an evidence line with `path:line`, a proposed patch, and the verification
that should prove it. "Fixed" is not a status an agent may claim: nothing an agent says makes a
change live. CI green plus a deploy SHA is the only proof, and that is recorded by the human side.

## Decision log

Every delegated task records its grant decision. Until the audit log exists, the parent run's
`tool_calls` row is the record; that gap is why autonomous merges stay off the table.
