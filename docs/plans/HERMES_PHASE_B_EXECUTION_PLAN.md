# HERMES Phase B — Execution Plan

**Status:** proposed, awaiting owner review. No code from this plan is merged.
**Baseline:** `main` = `3162917` (Phase A audited this commit; Phase A verdict L0–L4 NOT READY stands until a verified re-audit).
**Authority:** Sam's 2026-11-15 authorization. Conditional merging of low-risk PRs is the *eventual* capability and is gated; nothing in Phase B grants it.
**Hard limits carried into every workstream:** no merge, no production deploy, no production migration, no production secret read/rotation, no financial or signing action, no repository-setting or token change in this pass, no self-promotion.

---

## 1. Why the order is this order

Phase A found three defects that make every later capability unsafe to grant:

1. one shared bearer authorizes un-scoped execution of any agent with caller-chosen input (F-01);
2. no run can be attributed to an initiator (F-02);
3. the only thing preventing self-merge is missing code, while the agent credential already holds `admin: true` and protection requires zero approvals (F-03).

Each is a *precondition*, not a task. Merging authority, issue authority and review authority all read the same three signals, so building them first would mean building on an unchecked foundation. Phase B therefore front-loads the credential split, attribution and protected-resource enforcement, and defers every capability that consumes them.

Dependency graph:

```
B6 (posture, read-only) ──► informs B3 and B4 policy content
B2 (attribution schema) ──► B1 (operator authz decisions must be attributable)
B3 (protected resources) ─► B4 (review must know what is protected)
B2, B3 ───────────────────► B5 (alerts need both to be meaningful)
B1, B2, B3, B4, B5 ───────► graduation evidence for conditional merge (out of scope here)
```

Workstreams are independent enough for separate PRs; only B1 depends on B2's schema landing first, and even then only at the wiring step.

---

## 2. Workstreams, files, tests

### B2 — identity and audit attribution (do first)
No migration can run in this pass, so the deliverable is code plus a migration file that is reviewed, not applied.

Expected files:
- new `src/db/migrations/0002_run_attribution.sql` — additive only: `agent_runs.invoked_by`, `invoked_by_type` (`human|operator|scheduler|agent|delegator`), `policy_version`, `authz_decision`, `scope_hash`; `agent_audit_events` already carries `actor_type`, `authorization_context`, `correlation_id`, `run_id`.
- new `src/lib/attribution.ts` — one `Attribution` type and `recordAttribution(q, run, attribution)`; policy version constant.
- `src/agents/runner.ts` — accept `deps.attribution`, default to `{type:'agent'}` and refuse to guess; pass it to `run.created`, `run.started`, `run.completed`.
- `src/agents/audit-log.ts` — require `actorType` for privileged event types instead of defaulting silently.
- `src/routes/agents.ts` — pass `{type:'scheduler'|'operator', id}` from each entry point.
- `src/routes/admin.ts`, `src/agents/monitor.ts` — pass `{type:'human'}` for master-key calls.

Tests (`tests/attribution.test.ts`):
1. a run started from the cron path records `scheduler` + the slot id;
2. an ops-path run records `operator` + the credential id, never the secret value;
3. a delegated child inherits the parent's correlation id but records `delegator` and the parent run id;
4. audit failure for a privileged event throws (fail closed) while a `tool.invoked` failure does not;
5. a row written before the migration reads back with `invoked_by IS NULL` and the report says "unknown", not "agent".
6. no secret value appears in any audit column (scan the same fixtures for the bearer, the master key and a PAT shape).

Backfill, documented not run: existing rows stay NULL; `NULL` is honestly "unknown" and must never be rendered as `agent`.

### B3 — protected resource classification and write enforcement (safest first branch)
The write boundary already exists in one place, `src/agents/repo-write.ts:validateWritePath`, which is why this is the safest first implementation: it changes a pure function and its call site, adds no schema, and is fully testable offline.

Expected files:
- new `src/lib/protectedResources.ts` — the single source of truth: resource ids, matchers, and the required approver for each; `classifyResource(rawPath)`, `authorizeWrite(rawPath, actor)` returning `{allowed, resourceId, requires, reason}`.
- `src/agents/repo-write.ts` — replace the local `MONEY_PATHS` list with the central policy; deny by default; keep the existing prefix allowlist and credential scan unchanged.
- `src/lib/repoPolicy.ts` — the pinned-lookup/self-origin helper is *not* changed here; it stays B5/B6 scope.

Protection classes and matchers (all case-insensitive, separator-normalized, percent-decoded, Unicode-NFC):

| Class | Examples | Approver |
|---|---|---|
| `payments` | `src/payments/**`, `src/routes/credits.ts`, `src/lib/{billing,settle,reconcile,creditPolicy,keycredit,keybudget}.ts` | owner |
| `auth` | `src/routes/auth.ts`, `src/lib/session.ts`, `src/lib/security.ts`, `src/lib/keys.ts`, `src/lib/env.ts` | owner |
| `secrets` | `.env*`, `*.pem|key|p12|pfx`, `id_*`, `.npmrc`, `vercel.json`, `.vercel/**` | owner |
| `schema` | `src/db/schema.sql`, `src/db/migrations/**` | owner |
| `authority` | `team/policies/**`, `team/agents/**`, `src/lib/protectedResources.ts`, any future `src/authority/**`, `team/organization.json` | owner |
| `ci` | `.github/workflows/**`, `CODEOWNERS`, `.github/**` | owner |
| `deploy` | `vercel.json`, `package.json` scripts, `api/**` | owner |
| `wallet` | `src/payments/swap.ts`, `src/payments/x402.ts`, `src/lib/privy*`, contract abis, `contracts/**` | owner |
| everything else under the allowlist | `src/agents/**`, `web/src/**`, `tests/**`, `docs/**`, ordinary `src/lib/**` | agent, PR only |

Default: unknown or unmatched-but-sensitive requires owner. The classifier refuses rather than guesses.

Tests (`tests/protected-resources.test.ts`), all offline:
1. every protected class is refused for an agent actor and reports its id;
2. the ordinary control path (`src/agents/foo.ts`, `web/src/pages1.tsx`, `tests/x.test.ts`, `docs/y.md`) stays allowed, so the guard does not silently stop all work;
3. traversal: `src/payments/../../src/agents/x.ts`, `src/agents/../payments/swap.ts`, `..%2fsrc%2fpayments%2fswap.ts`;
4. case/encoding: `SRC/Payments/swap.ts`, `src/payments/swap.ts%00`, full-width dots, non-ASCII homoglyphs;
5. separator/alias: `src//payments/swap.ts`, `./src/payments/swap.ts`, `.\\src\\payments\\swap.ts`, leading/trailing whitespace;
6. symlink aliases: a path that resolves outside the tree is refused before any join;
7. batch partial write: one protected file among twelve allowed ones refuses the whole batch and names the file (no partial commit);
8. regression: the six existing cases in `tests/repo-write-guards.test.ts` keep passing unchanged.

### B1 — scheduler/operator split
Expected files: `src/routes/cron.ts` (new scheduler-only route), `src/routes/agents.ts` (ops path moves out or gains the operator gate and loses the scheduler bearer), `src/lib/operatorAuth.ts` (new), `src/lib/env.ts` (additive names only), `src/agents/cron.ts` (server-defined briefs), plus tests.

Scheduler route: server-derived work only. It computes due agents from the database and builds the brief itself; it accepts no `agent_id`, no `input`, no `pipeline_id`. A test asserts the schema rejects all three by name.

Operator path: short-lived, scoped, replay-protected. Design constraints:
- credential is a signed token with `sub` (operator id), `scope` (agent ids or `pipeline:*`), `ops` (operation vocabulary), `exp` (minutes), `jti` (single use), `max_spend_micros`;
- verification binds the token to the request body hash, so a captured token cannot be replayed with different input;
- idempotency key is mandatory and unique server-side; a duplicate returns the original result, never re-executes;
- rate limit per operator and per scope; spend cap enforced before the run;
- nothing new becomes a broad bearer: no single string grants the whole team.

Tests: scheduler rejects caller-supplied fields; operator token expiry, scope mismatch, replay, body-hash mismatch, spend over cap, rate limit, valid single use; a token value never lands in `agent_runs`, `agent_run_events`, `agent_audit_events` or logs.

Cutover/rollback (documented, not executed): new route live alongside the old one; the old bearer disabled only after one verified scheduled tick on the new path; rollback = re-enable the old route, delete the operator signing key.

### B4 — runtime reviewer/implementer independence
Expected files: new `src/lib/review.ts` (review record type, `checkReview(request, record)`), new migration `0003_review_records.sql`, `src/agents/repo-write.ts` or a new `src/agents/repo-review.ts` for the review action (review submission only, **no merge**), tests.

Review record binds: repo, PR number, head SHA, base SHA, reviewer id, implementer id, policy version, CI evidence digest, timestamp. `checkReview` rejects: reviewer == implementer, head SHA changed since review, base moved, CI evidence missing or stale, unknown reviewer, and any record whose signature does not verify.

Tests: the seven rejection cases plus one accepted case; a review of an older head is refused after a push; spoofing a reviewer id without the key fails.

### B5 — monitoring, scoped and attributable
Expected files: `src/routes/monitor.ts` (new scoped route), `src/agents/monitor.ts` (emit on privileged attempts and denials), `src/inngest/functions.ts` (scheduled audit), tests. Fail-closed rules for audit, authorization, scheduler and monitoring are stated as code paths and tested by injecting failures.

### B6 — GitHub posture plan (read-only in this pass)
Deliverable is this document plus a settings proposal; no API call that changes state. Verified vs proposed is separated in section 4.

---

## 3. PR split

| PR | Branch | Contents | Mergeable alone |
|---|---|---|---|
| P1 | `docs/hermes-phase-b-plan` | this plan | yes (docs only) |
| P2 | `feat/protected-resources` | B3 module, wiring, tests | yes |
| P3 | `feat/run-attribution` | B2 code + `0002` migration file (not applied) | yes |
| P4 | `feat/operator-authorization` | B1 routes, token verification, tests | after P3 |
| P5 | `feat/review-independence` | B4 records + `0003` migration (not applied) | after P2, P3 |
| P6 | `feat/monitor-scoping` | B5 route and alerts | after P3 |
| P7 | `docs/phase-a-reaudit` | verified re-audit at the new head | after P2–P6 |

No PR mixes payment-path code with authority code. P2 and P3 carry no payment changes at all.

---

## 4. Repository posture: verified now vs proposed

Verified 2026-11-15 through the API (read-only):
- required status check `verify`, `strict: false`;
- `required_approving_review_count: 0`; `dismiss_stale_reviews: true`; `require_code_owner_reviews: false`; `require_last_push_approval: false`;
- `enforce_admins: false`; force-push blocked; deletion blocked; no rulesets;
- no `CODEOWNERS` file in the repository;
- repository is public; squash, merge-commit and rebase all permitted; `delete_branch_on_merge: false`;
- the agent integration reports `permissions.admin: true` (critical excessive privilege);
- the audit token cannot read protection (`403`), the admin token can (`200`).

Proposed settings, for owner review only — **not applied**:
1. one required approving review, with `require_code_owner_reviews: true` and `require_last_push_approval: true`;
2. `strict: true` so the branch must be up to date;
3. `enforce_admins: true`;
4. squash-only merges; `delete_branch_on_merge: true`;
5. a `CODEOWNERS` file owning `src/payments/**`, `src/lib/{billing,settle,env,session,keys,security}.ts`, `src/db/**`, `.github/**`, `team/**`;
6. a ruleset on `main` that also protects `.github/workflows/**` from agent-authored changes;
7. replace the agent credential with a fine-grained PAT limited to `contents:write`, `pull_requests:write` on this one repository, no Administration, and a separate bot account so `enforce_admins` is a real wall rather than a norm.

Risk of each: (1)–(3) slow down the owner's own merges and are the only controls that survive a stolen agent credential; (4) removes merge commits from history; (5)–(6) require the CODEOWNERS owner to be a human with write access, which today is one account; (7) needs a new token and a re-link of the Vercel project's `GITHUB_TOKEN`, which is a production setting change and therefore explicitly out of scope for this pass.

What cannot be enforced by the current integration: Administration-scope changes (the fine-grained token gets `403`), and attention-level separation between agent and owner while both resolve to the same account.

---

## 5. Graduation gates (not to be evaluated in Phase B's implementation)

Conditional merging of eligible low-risk PRs stays disabled until all of the following are implemented, independently verified and recorded by someone other than the implementer:

1. B1 split live, with the old bearer disabled after one verified scheduled tick;
2. B2 attribution present on every entry point, with a re-audit showing no NULL initiators on new rows;
3. B3 enforcement at the write boundary, with the bypass tests green;
4. B4 review records bound to head SHA and a demonstrated rejection of self-review and stale-SHA approval;
5. B5 scoped monitoring emitting on denials, with fail-closed tests;
6. settings items 1–3 and 7 above applied, with the agent credential no longer `admin`;
7. a low-risk change actually merged by a non-author under those controls, with the audit trail naming every actor.

Until then: no merge, no self-promotion, no level marked graduated.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| A new authorization layer becomes the thing to bypass | One classifier, one call site at the write boundary, bypass tests in the same PR |
| Migration files reviewed but never applied, drifting from code | Migrations additive only, code tolerates NULL, re-audit before any apply |
| Splitting the credential breaks the scheduled path | New route parallel, old bearer disabled only after a verified tick, rollback documented |
| The operator token becomes the new master key | Scope + ops vocabulary + short expiry + body hash + single use + spend cap, each tested |
| Review independence is claimed but not bound to a SHA | Review record carries head and base SHA; stale-head approval is a test case |
| Phase B work is mistaken for graduated authority | This document states the verdict, and no level is marked graduated |
