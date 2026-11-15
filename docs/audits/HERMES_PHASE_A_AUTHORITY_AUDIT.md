# HERMES Phase A — Authority, Identity and GitHub Capability Audit

**Audit type:** read-only authority and capability audit (Phase A completion)
**Repository:** https://github.com/hakuramasam/thirdeye-ai
**Audited commit:** `3162917` (`main`, "Hand the monitor's worst findings to HERMES (#30)")
**Audit date:** 2026-11-15
**Auditor:** Elio, acting on Sam's Phase A completion directive
**Phase verdict:** **Phase A is complete as an audit. It does NOT pass. L0 is NOT READY, L1–L4 are NOT READY.**

> This document is documentation only. No production change, migration, deployment, secret
> rotation, financial operation, PR merge or authority promotion was performed in producing it.
> Every claim below is either a `file:line` in the audited commit, a GitHub API response captured
> during this audit, or explicitly marked UNVERIFIED.

---

## 1. Executive summary

The team can observe, delegate, reason and propose pull requests. It cannot manage issues, review
PRs, merge, or touch production, because those code paths do not exist. That is a real and useful
boundary, and it is the good news.

It is not the boundary the specifications describe, and three findings override it.

**The scheduler credential is a master key for team execution.** `POST|GET /api/cron/agents` is
guarded by one shared bearer string (`src/routes/agents.ts:293`) and, once presented, runs *any*
active agent with an *arbitrary* caller-supplied task (`src/routes/agents.ts:299-332`). There is no
agent identity, no task scope, no operation check and no independent authorization. Possession of a
single static string equals the ability to spend budget, drive every tool any agent holds, and
open pull requests. The directive instructed that L0 be demoted if the shared credential made it
effectively privileged. It does. **L0 is NOT READY.**

**The audit trail cannot name who started a run.** `agent_audit_events.actor_type` exists
(`src/db/schema.sql:541`) but no caller ever sets it; it defaults to `'agent'`
(`src/agents/audit-log.ts:267`), and `agent_runs` has no invoker column at all
(`src/db/schema.sql:119-130`). A cron tick, an operator ops-call and a session run are recorded
identically. Question 10 of the directive ("whether there are audit records identifying the actual
initiating agent") therefore answers **no**.

**Branch protection would not stop an agent that gained merge code.** Measured through the API, not
inferred: `required_approving_review_count: 0`, `require_code_owner_reviews: false`, no CODEOWNERS
file exists, `enforce_admins: false`, and the only required check is `verify` with `strict: false`.
The repository is public. The credential agents hold reports `permissions.admin: true`. What
prevents self-merge today is that `src/agents/repo-write.ts` stops at pull-request creation
(`:183-188`) — a code boundary, not a credential or policy boundary.

Two further gaps matter for the level model: the money-path refusal list in `repo-write.ts:28-33`
does **not** cover `src/routes/credits.ts` (the HTTP money surface), `src/lib/env.ts`,
`src/lib/session.ts`, `src/routes/auth.ts` or `.github/workflows/`, so the review gate that would
catch a hostile change to those files is the same gate that does not exist.

Readiness: **L0 NOT READY (credential is effectively privileged), L1 NOT READY, L2 NOT READY,
L3 NOT READY, L4 NOT READY.** Nothing was promoted, enabled or rotated.

---

## 2. Scope and methodology

**In scope:** agent runtime and delegation; repository read/write tools; GitHub integration and
credential posture; authentication/authorization middleware; cron and ops entry points; audit and
monitoring; invariant tests; repository settings and branch protection; both specifications.

**Method**

1. Every finding was re-read at the audited commit rather than carried over from the preliminary
   pass. Line numbers were re-resolved against `3162917` before being written here.
2. Source inspection traced call chains (`handler → runAgent → tool dispatch → tool`) rather than
   trusting file names or documentation.
3. GitHub state was read with `GET` requests only, using both credentials available to this
   workspace: the fine-grained token agents use (`GITHUB_TOKEN`) and the administrative classic
   token (`GITHUB_ACCESS_TOKEN`). Protection was read through the administrative token because the
   fine-grained token receives `403` on that endpoint, which is itself recorded as a finding.
4. Environment posture was verified by listing **variable names only** from the Vercel project
   (`GET /v9/projects/{id}/env`); no value was decrypted, printed, copied or stored.
5. Where a capability could only be proven by acting (merge, force-push, secret use), it was marked
   UNVERIFIED rather than tested, per the read-only mandate.
6. No destructive or financial operation was attempted. No repository setting was changed.

---

## 3. Files and components inspected

Verified present in the audited commit and read in this pass (not a complete file inventory; this
is what the findings rest on):

| Area | Path | Why |
|---|---|---|
| Agent runtime | `src/agents/runner.ts` | tool surface, write grant, delegation, stage-owner rule, crash path |
| Repository write | `src/agents/repo-write.ts` | write allowlist, money-path refusals, branch rules, PR creation |
| Repository read | `src/agents/repo-tools.ts` | what GitHub operations exist |
| Cron / ops | `src/routes/agents.ts`, `src/agents/cron.ts` | the `CRON_SECRET` boundary and scheduling |
| Schedule locking | `src/agents/schedule-lock.ts` | at-most-once execution, replay |
| Audit | `src/agents/audit-log.ts`, `src/db/schema.sql` | event model, append-only trigger, attribution |
| Monitoring | `src/agents/monitor.ts` | detectors, audit reachability |
| Pipelines | `src/agents/pipeline.ts` | ordering, ownership, rewinds |
| Admin surface | `src/routes/admin.ts` | what the master key can do |
| Config | `src/lib/env.ts`, `src/lib/security.ts`, `vercel.json` | secrets posture and schedule |
| Team docs | `team/agents/*/SKILL.md` (12 files), `team/organization.json`, `team/policies/authority.md` | claimed authority vs code |
| Tests | `tests/organization.test.ts` | the builder/verifier independence test |
| Specs | `HERMES-STAGEDAUTONOMOUSAUTHORITYMODELLevels.txt`, `HERMESAUTONOMOUSGITHUBGOVERNANCEANDPRLIFECYCLE.txt` | requirement comparison |

`team/agents/*/SKILL.md`: twelve skill packs exist (hermes, product, architect, backend, frontend,
blockchain, intelligence, agent-engineer, qa, sentinel, devops, docs). They are prompt text. None
of them is read by the backend at authorization time; `team/policies/authority.md` is likewise
prose. Authority therefore lives in code and credentials only — which is exactly the gap §6 records.

---

## 4. GitHub API verification results

Read-only. Endpoint, result and interpretation, as measured on 2026-11-15.

| Check | Endpoint | Result | Reading |
|---|---|---|---|
| Required status checks | `/branches/main/protection` | `verify` (app 15368), `strict: false` | A green `verify` is required; the branch need not be up to date with `main` |
| Required approvals | same | `required_approving_review_count: 0` | **No human approval is required to merge** |
| Code-owner review | same | `require_code_owner_reviews: false` | Off |
| CODEOWNERS file | repo tree | absent (`.github/` holds `workflows` only) | Cannot be enabled as written |
| Stale approvals | same | `dismiss_stale_reviews: true` | Moot while the count is 0 |
| Last-push approval | same | `require_last_push_approval: false` | A push after approval is not re-reviewed |
| Force pushes | same | `allow_force_pushes.enabled: false` | Blocked (enforced) |
| Branch deletion | same | `allow_deletions.enabled: false` | Blocked (enforced) |
| Admin enforcement | same | `enforce_admins.enabled: false` | Repo admins can bypass protection |
| Push restrictions | same | `restrictions: null` | No push allowlist |
| Rulesets | `/rulesets` | `[]` | No additional ruleset layer |
| Merge methods | `/repos/{r}` | squash, merge-commit, rebase all `true` | Policy not narrowed |
| Auto-merge | same | `allow_auto_merge: false` | Off |
| Delete branch on merge | same | `delete_branch_on_merge: false` | Branches accumulate |
| Visibility | same | `private: false` | **Repository is public** |
| Issues | same | `has_issues: true` | Feature available on the platform |
| Fine-grained token permissions | `/repos/{r}` as `GITHUB_TOKEN` | `{admin: true, maintain: true, push: true, triage: true, pull: true}` | Integration is highly privileged on this repo |
| Fine-grained token: protection read | `/branches/main/protection` as `GITHUB_TOKEN` | `403` | No Administration scope; protection cannot be managed by the agent credential |
| Classic token: protection read | same as `GITHUB_ACCESS_TOKEN` | `200` | Administrative token reads (and by scope, writes) settings |
| Issues read | `/issues?per_page=1` | `200` | Read possible; creation not tested (read-only mandate) |
| PR reviews read | `/pulls/43/reviews` | `200` | Read possible; review submission not implemented in code |
| Merged history | `/pulls?state=closed` | #44, #46, #32, #30, #47 merged 2026-11-15 | Merging to `main` does happen, and each merge deploys production |

**Capability classification required by the directive**

| Operation | Implemented in code | Available via integration | Permitted by repo settings | Documentation only |
|---|---|---|---|---|
| Read repo files | Yes (`repo-tools.ts:125,140,172`) | Yes | Yes | — |
| Open a PR on a feature branch | Yes (`repo-write.ts:183-188`) | Yes | Yes | — |
| Create/update/close issues | **No** | Yes (unused) | Yes | Claimed in Governance §1 |
| Apply labels / assign agents | **No** | Yes (unused) | Yes | Governance §1 |
| Submit PR review / request changes | **No** | Yes (unused) | Yes | Levels §2, Governance §3 |
| Approve a PR | **No** | Yes (unused) | Yes (0 required) | Levels §2 L2 |
| Merge a PR | **No** | Yes (admin: true) | Yes (0 approvals, verify only) | Levels §3 L3, Governance §5 |
| Close a PR | **No** | Yes | Yes | Governance §7 |
| Manage branch protection | **No** | No (403) | Admin token only | Levels §2 L3 checklist |
| Deploy production | **No** | Indirectly (merge → Vercel) | Yes | Levels §2 L4 |

The distinction that matters: **issues, reviews, approvals and merges are all available through the
authenticated integration but none is implemented in code.** The team is one small code change away
from a capability that repository settings do not gate.

---

## 5. CRON_SECRET security analysis

Answering the ten questions directly.

**5.1 Which endpoints accept it.** One. `registerCronRoute` mounts `app.on(['GET','POST'],
'/api/cron/agents', handler)` (`src/routes/agents.ts:396`); the guard is
`if (!env.cronSecret || auth !== \`Bearer ${env.cronSecret}\`) → 401` (`:293`). `env.cronSecret`
is `process.env.CRON_SECRET || ''` (`src/lib/env.ts:91`). No other route compares against it; the
master-key routes use `x-master-key` (`src/routes/admin.ts`, `src/routes/feedback.ts`) and are
separate credentials.

**5.2 What those endpoints can execute.** Two modes on one endpoint.

- *Scheduled mode* (no `agent_id`): selects up to 20 active agents with a `cron` expression
  (`:347-352`), decides due-ness against the last **successful** run with a 26-hour lookback
  (`:270`), takes a per-`(agent, slot)` lock (`:380`), and runs each with a fixed brief
  (`scheduledBrief`, `:272-284`).
- *Ops mode* (`body.agent_id`, `:299`): loads **any** agent row with `status='active'` regardless of
  owner (`:300`), then runs it with caller-supplied `input` truncated to 4000 characters (`:302`,
  `:332`). It may name a `pipeline_id` from the declared set (`:311-315`) and may supply an
  `idempotency_key` (`:321-328`).

**5.3 Does it grant arbitrary team operations?** Yes, transitively and without limit. The cron
credential does not itself write code, but the run it starts executes with that agent's full tool
surface: `repo_read`, `repo_write` (when the agent's `repo_access` is `write`, or when an
orchestrator passes `allow_write`), `delegate_to_agent` (with `allow_write` grantable to a
teammate, depth ≤ 3, `runner.ts:151,163`), `read_artifact` and, when x402 is enabled, `http_fetch`
with automatic payment (`runner.ts:208`). The caller chooses the instruction, so the caller chooses
what the agent does inside those tools. `repo_write` can open a PR touching `src/`, `web/`,
`tests/`, `docs/`, `team/` and `.github/` (`repo-write.ts:25`).

**5.4 Can HERMES or a delegated agent read the credential?** Not through any tool. The tool surface
(`runner.ts:440-478`) exposes no environment read, no shell and no file-system access; `.env` is not
tracked (`git ls-files` shows only `.env.example`) and `.env*` is refused by the write validator
(`repo-write.ts:35-42`). So the secret is not reachable in one hop. Two caveats keep this from being
a closed door: an agent with `repo_write` on `.github/` can propose a workflow that reads secrets,
and a merged workflow runs with repository secrets; and an agent with `http_fetch` can reach the
public endpoint — it needs the value, but nothing in the system would notice if it obtained one.

**5.5 Is the credential shared across unrelated roles?** Yes. One string authorises the scheduler,
every operator, and any runbook that pings the endpoint; it is the same value in production for the
Vercel cron and for any external pinger (the README instructs exactly that, `README.md:83-84`).
There is no per-role, per-purpose or per-agent credential.

**5.6 Can an agent invoke privileged operations indirectly?** Yes, in the specific sense the
directive asks about. `http_fetch` accepts any `http(s)` URL, any method and a body
(`runner.ts:203-216`). If the cron secret were ever in an agent's context — pasted into a task, a
PR, a log, a skill pack — that agent could drive the ops path end to end, including launching a
*write-enabled* orchestrator with a task of its choosing. This is why finding F-01 is rated
critical rather than high: the blast radius is not "the scheduler can schedule", it is "whoever
holds one string can direct the whole team".

**5.7 Is authorization checked independently of possession?** No. The comparison at `:293` is the
entire check. There is no session, no agent identity, no signature, no nonce, no timestamp
tolerance, no replay window, and no second factor.

**5.8 Are requests scoped by agent, task, resource and operation?** Only `pipeline_id` is validated,
against a declared list (`:311-315`) — a genuine positive control, since it refuses `__proto__` and
`constructor` by membership rather than property lookup. Nothing else is scoped: not which agent,
not which operations that agent may perform, not which paths it may propose, not how much it may
spend.

**5.9 Can replay or retry reuse a privileged request?** Yes by default. An ops call **without**
`idempotency_key` is deliberately not deduplicated (`:321-328` comment: "an ops call is a deliberate
fresh run and is not deduplicated"). So a captured request can be replayed at will, each replay
running the agent and spending budget. With a key, the `(agent, ops:<key>)` lock refuses the second
call inside the TTL (`schedule-lock.ts:39-61`), which is the right behaviour — it is simply optional.

**5.10 Do audit records identify the initiating agent?** No. `actor_type` is declared
(`schema.sql:541`) and defaulted to `'agent'` (`audit-log.ts:267`); no code path passes
`'scheduler'` or `'owner'`, grepping `actorType` in `src/` returns only the type declaration and the
default. `agent_runs` records `agent_id`, `user_id`, status, counters and spend
(`schema.sql:119-130`) but nothing about the caller. A scheduled tick and an operator ops-call with
an arbitrary task are indistinguishable in the audit trail, so "who told HERMES to do this" cannot be
answered from records after the fact.

**5.11 Verdict on the credential.** `CRON_SECRET` is confirmed present in production
(variable name verified via the Vercel env listing; value never read). It is a single static bearer
that confers un-scoped team execution with no independent authorization and no initiator
attribution. **This makes L0 effectively privileged, so L0 is demoted to NOT READY** as the
directive requires.

**5.12 Least-privilege recommendation.** In priority order:

1. **Split the credential by purpose.** A `SCHEDULER_SECRET` that can only do scheduled mode (no
   `agent_id`), and a separate `OPERATOR_SECRET` for ops mode, held only by Sam and never in an
   agent's reach. Rotate both, and record the rotation date.
2. **Make the endpoint identity-bearing.** Sign the request (HMAC over method, path, body hash,
   timestamp, nonce) with a per-caller key, reject on clock skew, and store the nonce so a replayed
   body is refused. Vercel cron cannot sign, so put Vercel on the scheduler key alone.
3. **Scope ops mode to a declared job vocabulary.** Allow `{job: 'audit' | 'report' | 'sweep'}` with
   a fixed input template per job, instead of free-text `input` plus any `agent_id`. The caller then
   cannot compose a novel instruction.
4. **Require idempotency keys in ops mode** (make the current optional lock mandatory) and cap
   per-caller daily runs and spend.
5. **Attribute every run.** Add `invoked_by`/`trigger` to `agent_runs` and pass `actorType:
   'scheduler' | 'owner' | 'agent'` plus an `authorization_context` (which credential, which caller
   id) into `recordRunEvent`. Without this, no incident can be reconstructed.
6. **Close the indirect path.** Restrict `http_fetch` to an allowlist of external hosts, refuse
   requests to the deployment's own origin, and never let an agent-visible document contain a
   bearer.

---

## 6. Agent identity and permission architecture

**What exists today.** Authority is three columns on `agents` — `repo_access`, `can_delegate`,
`credit_usd_micros` — plus a per-run write grant `RunnerDeps.allowWrite` (`runner.ts:477`). Tool
availability is computed per run from those fields (`runner.ts:440-478`): `repo_read` when
`repo_access` is `read` or `write`, `repo_write` only when the run holds the grant,
`delegate_to_agent` only when `can_delegate`, `http_fetch` only when `x402_enabled`,
`read_artifact` always.

**What does not exist.** Grepping `authority|permission|approval` in `src/db/schema.sql` returns
nothing: there is no permission registry, no `AGENT_AUTHORITY`, `AGENT_PERMISSIONS`,
`AUTHORITY_DECISIONS`, `AUTHORITY_PROMOTIONS` or `AUTHORITY_AUDIT_EVENTS` table, no risk
classification (R0–R4) and no level field anywhere. The Levels specification requires all of these.
The `approval.*` audit event types exist in the type union (`audit-log.ts:53-56`) with no producer.

**Identity.** An agent run is identified by `agent_id` — a name lookup inside `team/organization.json`
(`runner.ts`, teammate resolution by `name`). There is no cryptographic identity, no per-agent
credential (one shared GitHub token serves them all, `env.ts` ↗ `repo-write.ts:133`), and no way for
the backend to distinguish a genuine QA verdict from a fabricated one beyond reading the prose.

**Delegation.** `delegate_to_agent` carries `agent`, `task` and `allow_write` (`runner.ts:163-183`).
The grant is recorded in the parent's report ("[write granted for this task]"). Chain depth is capped
at 3 (`runner.ts:151,613-615`). Pipeline stages enforce that the stage owner is the delegate, else
`stage_owner_mismatch` (`runner.ts:669`). These are good controls; none of them is an identity or
authority model.

**What the specifications require and the code lacks.** Explicit permissions per level; entry,
promotion and demotion criteria; enforcement in the backend rather than the prompt (Levels §1 states
this explicitly); a checklist engine consulted before each action; suspension states
(NORMAL/RESTRICTED/SUSPENDED/REVOKED); and promotion evidence that cannot be self-reported. None is
implemented.

---

## 7. Builder/verifier independence analysis

**The current mechanism is a file-structure test.** `tests/organization.test.ts:74` asserts that for
each declared pipeline the `test_report` stage's owner differs from the `build` stage's owner, that
`review` differs too where present, that `tdt_qa` and `tdt_sentinel` carry
`independent_verification: true`, and (`:197-204`) that a unit's `reviews_paths` are not among its
own `owns_paths`. `team/organization.json` carries analogous declarations. This proves the
*documents* are internally consistent. It cannot prove anything about a run.

**Runtime enforcement: absent.** Grepping `reviewer|self_review|reviewed_by` across `src/` returns
only unrelated prose in `src/routes/public.ts`. No run is checked against a reviewer identity, no PR
records a reviewer, and `repo-write.ts` ends at pull-request creation (`:183-188`) so there is no
review event to bind to. Consequently, every threat the directive lists is currently possible:

| Threat | Prevented today? | Why |
|---|---|---|
| Implementation agent reviews its own change | **No** | No reviewer role exists in code; a PR opened by an agent has no author concept the backend tracks |
| Agent impersonating an independent reviewer | **No** | Reviewer identity is unstructured text in a report; nothing verifies who produced it |
| Delegated agent reusing the implementer's identity | **Partially** — each delegation creates a run with its own `agent_id` and `parent_run_id`, but the agent name is caller-selected | Identity is a string the orchestrator chooses |
| Orchestrator accepting self-reported QA as independent | **No** | Nothing marks a report as independent; instructions are prose |
| Reviewer evaluating a different commit than merged | **No** | No head-SHA binding exists anywhere in the flow |

**Runtime controls required** (none of which exist): authenticated agent identity per run (an
issued, verifiable token rather than a name); an immutable implementer identity recorded on the
PR/task; a reviewer identity distinct by construction, with reviewer-role authorization checked
server-side; PR head SHA captured at review time and re-checked at merge, refusing if it moved;
evidence provenance (which run id, which artifact, which tool output produced a verdict, stored so
it cannot be rewritten — the append-only `agent_audit_events` trigger, `schema.sql:593-596`, is the
right substrate); conflict-of-interest rejection by construction; backend rejection of self-review;
and an audit event for every review decision (`approval.*` types already exist unused).

Until that exists, "the builder is never the verifier" is a convention the orchestrator is asked to
follow, not a property of the system.

---

## 8. GitHub lifecycle capability assessment

Per operation, against the four-level classification in §4: **issues, labels, assignment, formal
reviews, approvals, merges, PR closure and changelog updates are all unimplemented in code and all
available to the integration.** `repo-tools.ts` exposes only `contents`, `git/refs`,
`search/code` and `pulls` (create) — specifically there is no `/issues`, no
`POST /pulls/{n}/reviews`, no `PUT /pulls/{n}/merge` client (`repo-tools.ts:84-183`,
`repo-write.ts:145-192`).

Two consequences worth separating.

*The honest one:* HERMES cannot perform the Governance specification's lifecycle today, and cannot
accidentally do so either, because the code is not there.

*The dangerous one:* the missing code is a thin wrapper, while the underlying permission, the
administrative repo permission and the empty approval requirement are already in place. Adding an
issue client would give issue closure the specs allow but do not gate; adding a merge client would
give self-merge. Neither would be refused by GitHub: with `required_approving_review_count: 0` and
`strict: false`, a PR that passes `verify` is mergeable, and the token reports `admin: true`.

Repository settings that need attention before any of that is built: require ≥ 1 approving review
from someone other than the last pusher (`require_last_push_approval: true`), add a CODEOWNERS file
covering `src/payments/`, `src/db/`, `src/lib/env.ts`, `src/routes/`, `src/agents/`, `.github/`, then
enable `require_code_owner_reviews`; set `enforce_admins: true`; make `verify` `strict: true` so a
stale branch cannot merge; narrow merge methods to squash only; enable
`delete_branch_on_merge`. These are owner actions on repository settings and were **not** performed
(no settings changes were made in this audit).

---

## 9. Audit, monitoring and replay analysis

**Audit — strong substrate, weak attribution.** `agent_audit_events` is append-only: a trigger
refuses `UPDATE` and `DELETE` (`schema.sql:593-596`). Events carry `correlation_id`, `run_id`,
`parent_run_id`, `task_id`, `pipeline_id`, `stage_id`, `event_type`, `actor_type`,
`authorization_context`, `tool_name`, `artifact_ids`, `status`, `error_code`, `metadata`
(`schema.sql:524-556`). Critical events fail closed; tool-level rows are best-effort. Child runs
inherit the correlation id, so a delegation tree is reconstructible.

But: `actor_type` is always `'agent'` (F-02), `authorization_context` is never populated by any
caller, and there is no event when a credential is *presented* — the cron guard returns 401 or runs,
and nothing is written either way. An unauthorised probe of the endpoint leaves no trace at all.

**Monitoring — detectors exist, delivery does not.** `detectFindings` in
`src/agents/monitor.ts:80+` classifies run-level pathologies (stuck run, claimed success without
evidence, spend anomalies, high failure rates) and `auditAgents` (`monitor.ts:253`) turns them into
findings and alerts. `auditAgents` is called from exactly one place: `src/routes/admin.ts:164`,
behind `x-master-key`. `vercel.json` schedules only `/api/cron/agents` at `0 9 * * *`. So the audit
that would notice a privileged or misbehaving run is not on a schedule, and failed runs raise no
alert unless someone calls the admin route. This is the same gap recorded in the preliminary pass and
it is unchanged (F-09).

**Replay — well handled on the scheduled path, optional on the ops path.** The scheduled path locks
per `(agent, slot)` (`schedule-lock.ts:39`), with a TTL and steal-on-expiry semantics, so an
overlapping tick records a skip and never double-executes or double-charges. Due-ness is measured
against the last *successful* run with a 26-hour lookback (`agents.ts:270`), which means a missed
day is retried rather than lost — a deliberate trade that also means a late tick can run a slot up
to 26 hours stale. Ops mode deduplicates only when the caller supplies `idempotency_key`
(`agents.ts:321-328`), so replay of a privileged request is permitted by default.

---

## 10. Specification comparison

Two documents: **Levels** (HERMES Staged Autonomous Authority Model) and **Governance** (Autonomous
GitHub Governance and PR Lifecycle). Requirement-level comparison follows; where they disagree, the
conflict is recorded rather than resolved, because precedence is the owner's decision.

**10.1 Shared requirements** — both demand: independent verification with the implementer excluded as
sole reviewer (Levels §2 L2, Governance §4); evidence inspection rather than trusting self-reported
success (Levels §2, Governance §3); issue closure only on verified integration (Levels §2 L1,
Governance §2); security review before merge for sensitive areas (Levels §2 L2/L3, Governance §4-5);
persisted audit records (Levels §3, Governance §5); and no fabricated execution results (Levels §2
L0 checklist, Governance §3).

**10.2 Unique to Levels** — the five-level model itself; per-level permitted/prohibited action lists;
promotion evidence and windows (L1→L2: 20 independently verified management tasks; L2→L3: 30
independently verified review decisions; L3→L4: 60 days monitored low-risk integration); the
required tables (`AGENT_AUTHORITY`, `AGENT_PERMISSIONS`, `AUTHORITY_DECISIONS`,
`AUTHORITY_PROMOTIONS`, `AUTHORITY_AUDIT_EVENTS`); per-level operational checklists; risk classes
R0–R4; demotion/suspension states (NORMAL/RESTRICTED/SUSPENDED/REVOKED); the explicit rule that
authority is enforced by the backend, not the prompt; and the initial configuration (L0/L1 active,
L2 conditional, L3 restricted, L4 disabled).

**10.3 Unique to Governance** — issue lifecycle operations (create, update, label, assign, close,
reopen, duplicate handling); PR review operations (formal reviews, request changes, approve); the
eleven-point merge checklist; seven-step post-merge verification; closure of obsolete/abandoned PRs
with documented reasons; the rebase/conflict-resolution procedure; and the financial/security
exception list (payment settlement, ledger integrity, wallet signing, treasury, financial
authorization, authentication, authorization, production secrets, critical migrations, contract
execution, transaction policies).

**10.4 Conflicts — recorded, not resolved**

| # | Conflict | Levels | Governance | Also contradicts |
|---|---|---|---|---|
| C1 | May HERMES merge autonomously? | L3 only, "unless L3 is separately activated"; low-risk classes only | §1 and §5 grant autonomous merge of eligible PRs outright | `team/policies/authority.md`: "Merging to `main` and deploying to production… Sam's word decides that, not HERMES" |
| C2 | Who authorises authority itself? | §3: "A human-authorized governance decision must activate each promotion" | §1: "Do not ask the founder for routine issue or PR management decisions" | The two cannot both govern the same actor |
| C3 | Scope of "low risk" | Enumerated examples (docs, non-sensitive UI, isolated fixes, tests, refactors) | No risk classification; §6 lists exceptions only | Levels' R0–R4 is undefined in Governance, so "eligible" is unfalsifiable under Governance alone |
| C4 | Issue closure timing | Closure requires integration into the target branch (L1) | Same rule, but permits closing duplicates and abandoned PRs | Compatible; recorded because "duplicate" is undefined |

**10.5 Security gaps present in both** — neither defines: how reviewer identity is authenticated;
how evidence provenance is proven (run id, artifact, tool output); how PR head SHA is bound to a
review; how a credential is scoped or rotated; what happens when an agent's credential is
compromised; how to detect a fabricated report mechanically rather than by reading prose; or how
promotions are recorded so they cannot be self-granted.

**10.6 Missing acceptance criteria** — no spec states the enforcement tests ("an agent at L1 that
attempts a merge must receive a backend refusal of type X"), no schema, no mapping from paths to risk
classes, no definition of "independently verified", and no recovery procedure if verification
evidence is unavailable and CI is green.

**10.7 Requirement-to-code traceability** — summarised:

| Requirement | Source | Code status |
|---|---|---|
| Backend-enforced authority levels | Levels §1 | Not implemented |
| Authority/permission tables | Levels §2 | Not implemented (no such tables in `schema.sql`) |
| Promotion/demotion machinery | Levels §3-4 | Not implemented |
| Checklist engine consulted before actions | Levels §2 | Not implemented |
| Issue lifecycle | Governance §1-2 | Not implemented; available via integration |
| PR review/approve | Governance §3 | Not implemented; available via integration |
| Merge with 11-point checklist | Governance §5 | Not implemented; permitted by settings |
| Independent verification beyond docs | Levels §2, Governance §4 | Documentation + static test only (`tests/organization.test.ts:74`) |
| Persisted audit of decisions | Levels §3, Governance §5 | Substrate yes; attribution and decision events no |
| Append-only audit log | Levels §3 | Implemented (`schema.sql:593-596`) |
| Per-run write grant, depth cap, stage-owner rule | (emergent, both) | Implemented (`runner.ts:151,477,669`) |
| Credential scoping | implied by both | Not implemented (one shared `CRON_SECRET`) |

**10.8 Owner decisions required** — see §15.

---

## 11. L0–L4 readiness matrix

| Level | Defined capability | Verdict | Basis |
|---|---|---|---|
| **L0** Observe & analyse | Read repo, inspect issues/PRs/CI, analyse history, produce reports | **NOT READY** | The observation path runs on the same credential that can execute any active agent with an arbitrary task (F-01), and runs cannot be attributed to an initiator (F-02). The directive requires demotion when the shared credential makes L0 effectively privileged; it does. |
| **L1** Manage & coordinate | Create/update/close issues, labels, assignment, task plans, delegation, roadmap | **NOT READY** | No issue capability in code (F-06); no authority tables, so "may do X at L1" is unenforceable (F-04); delegation works but on a chosen-name identity (F-05). |
| **L2** Review & recommend | Review PRs, verify SHA, reject, approve low-risk | **NOT READY** | No review capability (F-07); no reviewer identity or head-SHA binding (F-05); branch protection would not distinguish an agent's approval from a human's (F-03). |
| **L3** Conditional merge | Approve/merge low-risk, post-merge verification | **NOT READY** | No merge code; settings require 0 approvals; token holds admin; money-path refusals miss the money HTTP surface (F-03, F-08). Must not be activated in this state. |
| **L4** Production & financial | Deploy, migrations, treasury | **NOT READY** | Nothing implemented; merging to `main` auto-deploys production, so L3 without L4 controls would grant production authority by side effect. |

Positive controls verified and worth preserving: `repo_write` refuses `.env`, `.git`,
`node_modules`, key material, `src/payments/`, billing/settlement/keys modules and `schema.sql`;
branch names are forced to `agent/<slug>` and `agent/main` is refused; 12 files / 200 KB per PR; a
credential-shaped-string scan runs on proposed content; delegation depth is capped at 3; the
pipeline stage owner must match the delegate; append-only audit trigger; critical audit events fail
closed; scheduled runs are lock-protected per slot; config guard returns 503 rather than booting
misconfigured; `checkSenderOwnership` blocks claiming another wallet's transfer.

---

## 12. Findings

Severity: Critical / High / Medium / Low. Status: VERIFIED (read in code or measured via API),
UNVERIFIED (could not be proven read-only).

| ID | Sev | Status | Component | Finding | Evidence | Impact | Remediation |
|---|---|---|---|---|---|---|---|
| F-01 | Critical | VERIFIED | Cron credential | One static shared bearer authorises un-scoped execution of any active agent with arbitrary input | `src/routes/agents.ts:293,299-332,396`; `src/lib/env.ts:91`; production env contains `CRON_SECRET` | Whoever holds the string directs the whole team, its spend and its write capability | Split scheduler/operator credentials, sign requests, scope ops to a job vocabulary, require idempotency, rotate |
| F-02 | Critical | VERIFIED | Audit attribution | `actor_type` always defaults to `'agent'`; no invoker recorded; cron, ops and session runs indistinguishable | `src/agents/audit-log.ts:267`; `src/db/schema.sql:541,119-130`; `grep actorType` → no callers | No incident can be reconstructed; fabricated work cannot be attributed | Add `invoked_by`/`trigger` to runs, pass `actorType` and `authorization_context` at every entry point, log credential presentation (success and failure) |
| F-03 | Critical | VERIFIED | Repo posture | Merge is gated by nothing but `verify`: 0 required approvals, no CODEOWNERS, `enforce_admins:false`, `strict:false`; repo public; agent token `admin:true`; merge code absent | `/branches/main/protection`; `/repos/{r}`; `/rulesets` → `[]` | The only thing preventing agent self-merge is a missing wrapper; the permission already exists | Require ≥1 non-author approval, CODEOWNERS + code-owner reviews, `enforce_admins`, `strict`, squash-only, before any merge/issue capability is built |
| F-04 | High | VERIFIED | Authority model | No permission registry, no authority/decision/promotion tables, no risk classes, no level field | `grep 'authority|permission|approval' src/db/schema.sql` → none; `approval.*` event types declare no producers (`audit-log.ts:53-56`) | L1–L4 cannot be enforced as specified; every level claim is a prompt instruction | Implement the five tables and a backend `authorize(agent, operation, resource)` consulted in the runner and in every route |
| F-05 | High | VERIFIED | Independence | Builder/verifier separation is a static file-structure test; no runtime reviewer identity, no SHA binding, no self-review rejection | `tests/organization.test.ts:74,197-204`; `grep reviewer|self_review|reviewed_by src/` → none | An implementation agent can review, approve or vouch for its own work undetected | Reviewer identity per decision, head-SHA captured and re-checked at merge, provenance stored as artifacts, backend refusal of self-review, `approval.*` events emitted |
| F-06 | High | VERIFIED | GitHub capability | No issues/labels/assignment client exists | `src/agents/repo-tools.ts:84-183` (contents, refs, search, pulls only) | L1 is impossible today | Add issue capability only with F-03 and F-04 closed |
| F-07 | High | VERIFIED | GitHub capability | No PR review/approve client exists | `src/agents/repo-write.ts:183-188` (stops at PR creation) | L2 is impossible today | As F-06, plus reviewer identity |
| F-08 | High | VERIFIED | Write boundary | Money-path refusals miss the money HTTP surface and security/config code; `.github/` and `team/` are writable | `src/agents/repo-write.ts:25` (allowlist includes `team/`, `.github/`), `:28-33` (`MONEY_PATHS` lacks `src/routes/credits.ts`, `src/lib/env.ts`, `src/lib/session.ts`, `src/routes/auth.ts`), `:35-42` (denied list) | An agent can propose changes to its own policies, CI workflows and the credit routes; the review gate that would catch it is F-03 | Extend `MONEY_PATHS` to the credits/auth/env/session routes, treat `.github/` and `team/` as human-signature paths, and require owner review for them by CODEOWNERS |
| F-09 | High | VERIFIED | Monitoring | The audit that detects misbehaving runs is only reachable with the master key and is not scheduled; `vercel.json` schedules only `/api/cron/agents` | `src/agents/monitor.ts:80,253`; `src/routes/admin.ts:164`; `vercel.json` crons | Failed or privileged runs raise no alert by default | Schedule `auditAgents` on its own cron with a scoped credential, and emit an alert event on findings |
| F-10 | Medium | VERIFIED | Indirect invocation | `http_fetch` accepts any URL/method/body with automatic x402 payment and no origin allowlist | `src/agents/runner.ts:203-216,208` | A leaked bearer anywhere in agent-reachable content converts into team control; also an SSRF surface | Host allowlist, refuse the deployment's own origin and RFC1918/metadata ranges, cap spend per call |
| F-11 | Medium | VERIFIED | Replay | Ops mode is not deduplicated unless the caller volunteers an idempotency key | `src/routes/agents.ts:321-328` | A captured privileged request replays indefinitely | Make the key mandatory, add per-caller rate and spend caps |
| F-12 | Medium | VERIFIED | Pipeline scoping | `pipeline_id` is validated by membership, not property lookup — a positive control | `src/routes/agents.ts:311-315` | Prevents prototype-key bypass | Keep; extend the same pattern to every enum input |
| F-13 | Medium | VERIFIED | Visibility | Repository is public | `/repos/{r}` → `private:false` | Every proposed change, issue and doc is world-readable; `repo_read` is not a confidentiality boundary | Decide deliberately; if the repo stays public, treat all agent-visible content as publishable |
| F-14 | Medium | VERIFIED | Schedule semantics | Due-ness uses a 26-hour lookback on the last successful run | `src/routes/agents.ts:270` | A late tick can execute a slot up to a day stale, using a current brief | Acceptable trade; record it so "why did it run now" is answerable |
| F-15 | Low | VERIFIED | Review config | No CODEOWNERS file exists | repo tree; `.github/` has `workflows` only | Code-owner review cannot be enabled | Add CODEOWNERS covering sensitive paths |
| F-16 | Low | VERIFIED | Protection strictness | Required check `verify` has `strict:false` | `/branches/main/protection` | A branch green on an older base is mergeable | Set `strict:true` |
| F-17 | — | UNVERIFIED | Scheduler delivery | Whether Vercel actually sends `Authorization` on the scheduled tick, and whether any scheduled run has completed | production env has `CRON_SECRET` (name only); no cron execution observed in this audit | Cannot confirm the scheduled path works end to end | Observe one scheduled tick with a run id and record it |
| F-18 | — | UNVERIFIED | Merge capability | Whether the fine-grained token can actually merge to `main` | not tested (read-only mandate); token reports `admin:true` | Determines whether F-03 is theoretical or immediate | Test once on a throwaway branch, or accept F-03 and harden settings first |
| F-19 | — | UNVERIFIED | Vercel settings | Whether deployment protection blocks direct production access | not inspected | Affects blast radius of a bad merge | Inspect project settings read-only |
| F-20 | Low | VERIFIED | Doc drift | README documents an hourly cron; `vercel.json` schedules daily at 09:00 UTC | `README.md:84` vs `vercel.json` `crons[0].schedule = "0 9 * * *"` | Operators expect 24 retries a day and get one; a missed day is retried by the 26-hour lookback instead | Correct the README, or move the schedule to what the doc claims |

### Machine-readable evidence

```json
[
 {"id":"F-01","severity":"critical","status":"verified","type":"credential_boundary","evidence":["src/routes/agents.ts:293","src/routes/agents.ts:299-332","src/routes/agents.ts:396","src/lib/env.ts:91"],"level_impact":["L0","L1","L2","L3","L4"]},
 {"id":"F-02","severity":"critical","status":"verified","type":"audit_attribution","evidence":["src/agents/audit-log.ts:267","src/db/schema.sql:541","src/db/schema.sql:119-130"],"level_impact":["L0","L1","L2","L3","L4"]},
 {"id":"F-03","severity":"critical","status":"verified","type":"repo_protection","evidence":["GET /repos/hakuramasam/thirdeye-ai/branches/main/protection","GET /repos/hakuramasam/thirdeye-ai","GET /repos/hakuramasam/thirdeye-ai/rulesets","src/agents/repo-write.ts:183-188"],"level_impact":["L2","L3"]},
 {"id":"F-04","severity":"high","status":"verified","type":"authority_model","evidence":["src/db/schema.sql (no authority tables)","src/agents/audit-log.ts:53-56"],"level_impact":["L1","L2","L3","L4"]},
 {"id":"F-05","severity":"high","status":"verified","type":"independence","evidence":["tests/organization.test.ts:74","tests/organization.test.ts:197-204","grep reviewer src/ -> none"],"level_impact":["L2","L3"]},
 {"id":"F-06","severity":"high","status":"verified","type":"capability_gap","evidence":["src/agents/repo-tools.ts:84-183"],"level_impact":["L1"]},
 {"id":"F-07","severity":"high","status":"verified","type":"capability_gap","evidence":["src/agents/repo-write.ts:183-188"],"level_impact":["L2"]},
 {"id":"F-08","severity":"high","status":"verified","type":"write_boundary","evidence":["src/agents/repo-write.ts:25","src/agents/repo-write.ts:28-33","src/agents/repo-write.ts:35-42"],"level_impact":["L2","L3"]},
 {"id":"F-09","severity":"high","status":"verified","type":"monitoring","evidence":["src/agents/monitor.ts:80","src/agents/monitor.ts:253","src/routes/admin.ts:164","vercel.json"],"level_impact":["L0","L4"]},
 {"id":"F-10","severity":"medium","status":"verified","type":"indirect_invocation","evidence":["src/agents/runner.ts:203-216"],"level_impact":["L1","L2","L3","L4"]},
 {"id":"F-11","severity":"medium","status":"verified","type":"replay","evidence":["src/routes/agents.ts:321-328"],"level_impact":["L1","L2"]},
 {"id":"F-12","severity":"medium","status":"verified","type":"positive_control","evidence":["src/routes/agents.ts:311-315"],"level_impact":[]},
 {"id":"F-13","severity":"medium","status":"verified","type":"visibility","evidence":["GET /repos/hakuramasam/thirdeye-ai -> private:false"],"level_impact":["L0","L1"]},
 {"id":"F-14","severity":"medium","status":"verified","type":"schedule_semantics","evidence":["src/routes/agents.ts:270"],"level_impact":[]},
 {"id":"F-15","severity":"low","status":"verified","type":"review_config","evidence":["repo tree: no CODEOWNERS"],"level_impact":["L3"]},
 {"id":"F-16","severity":"low","status":"verified","type":"protection_strictness","evidence":["GET /branches/main/protection -> strict:false"],"level_impact":["L3"]},
 {"id":"F-17","severity":null,"status":"unverified","type":"scheduler_delivery","evidence":["production env names only"],"level_impact":[]},
 {"id":"F-18","severity":null,"status":"unverified","type":"merge_capability","evidence":["not tested (read-only)"],"level_impact":["L3"]},
 {"id":"F-19","severity":null,"status":"unverified","type":"deployment_protection","evidence":["not inspected"],"level_impact":["L4"]},
 {"id":"F-20","severity":"low","status":"verified","type":"doc_drift","evidence":["README.md:84","vercel.json crons"],"level_impact":[]}
]
```

---

## 13. Unverified areas and access limitations

- **Merge capability of the integration token (F-18).** Proving it requires performing a merge, which
  the read-only mandate forbids. The token's `permissions.admin: true` makes it likely; treat it as
  true until disproved.
- **Branch-protection administration by the agent credential.** `403` on read confirms no
  Administration scope for `GITHUB_TOKEN`; whether the *classic* token would allow a settings change
  was not tested (it read protection with `200`, which implies scope).
- **Scheduled execution end to end (F-17).** No cron tick was observed during this audit. The
  production environment does contain `CRON_SECRET` (name verified; value never read).
- **Vercel deployment protection (F-19)** and preview/production environment differences were not
  inspected in this pass.
- **Workflow secrets.** `.github/workflows/` exists; its contents and the secrets it can reach were
  not enumerated, so the "agent proposes a workflow that exfiltrates secrets" path in §5.4 is
  reasoned from the allowlist, not demonstrated.
- **Agent-visible memory and artifacts.** Whether any stored artifact or memory contains a bearer
  was not scanned; doing so needs a targeted read of artifact content.
- **Runtime behaviour under load, provider failure and rate limiting** belongs to Phase B, not this
  audit.

---

## 14. Recommended remediation priorities

**P0 — before any authority work continues**

1. Split and rotate the cron credential; sign or scope ops requests; make idempotency mandatory
   (F-01, F-11).
2. Add initiator attribution: `invoked_by`/`trigger` on `agent_runs`, `actorType` and
   `authorization_context` populated at every entry point, credential-presentation events on success
   *and* failure (F-02).
3. Harden repository settings before writing any review/merge code: ≥1 non-author approval,
   CODEOWNERS + code-owner reviews, `enforce_admins: true`, `strict: true`, squash-only (F-03, F-15,
   F-16). Owner action; not performed here.
4. Extend `MONEY_PATHS` to `src/routes/credits.ts`, `src/routes/auth.ts`, `src/lib/env.ts`,
   `src/lib/session.ts`; treat `.github/` and `team/` as human-signature paths (F-08).

**P1 — the authority model itself**

5. Implement the five authority tables plus a backend `authorize(agent, operation, resource, level)`
   consulted in the runner and every privileged route; no level may be granted by prompt (F-04).
6. Implement reviewer identity, head-SHA binding, provenance and backend self-review refusal, with
   `approval.*` events (F-05).
7. Schedule the monitor and alert on findings (F-09).

**P2 — capability building, only after P0/P1**

8. Issue lifecycle capability, then review capability, each behind the authority check (F-06, F-07).
9. `http_fetch` host allowlist and self-origin refusal (F-10).
10. Decide repository visibility deliberately (F-13).

---

## 15. Required owner decisions

1. **Precedence between the two specifications.** Governance §1/§5 grant autonomous merge; Levels L3
   gates merge behind a separately activated level; `team/policies/authority.md` reserves merging and
   deployment to Sam. Which governs? Recommendation: Levels plus the written policy, with Governance
   read as describing the *lifecycle* HERMES may manage once L3 is legitimately activated.
2. **Whether HERMES may ever hold merge authority.** Recommendation: not until P0 items 3 and 4 are
   in force and P1 item 6 exists, and then only for the enumerated low-risk classes with a human
   CODEOWNERS approval on sensitive paths.
3. **Risk-class definition (R0–R4 → paths).** The specs name the classes but never map them. A path
   mapping is needed before any "eligible low-risk" decision can be made honestly.
4. **Credential architecture.** Approve the split (scheduler vs operator), the rotation, and who holds
   the operator credential. Rotation is a production secret change and is Sam's call.
5. **Repository visibility.** If the repo stays public, accept that every proposed change is
   world-readable and that agent-visible content is publishable.
6. **Scope of Phase B.** Whether Phase B starts from the authority model (P1) or from the capability
   gaps (P2) — they are ordered, not parallel, if the merge path is ever to be opened.
7. **Whether to accept the "documentation-only independence" gap temporarily.** If accepted, no PR
   may be described as independently reviewed, and no level above L0 may be claimed in public
   material.

---

## 16. Phase A completion verdict

**Phase A is complete as an audit.** All required inspections were performed at a named commit:
source, tests, skill packs, docs, specifications, GitHub settings via API, credential posture by name
only, and the ten CRON_SECRET questions answered with file and line references. The gaps in the
preliminary pass are closed: `monitor.ts`, the twelve `SKILL.md` packs, the delegation and
repository-write modules, the auth middleware, the cron handlers and the independence test were all
read, and the GitHub API was queried rather than assumed. Twenty findings are recorded with
severity, evidence, impact, remediation and verification status; four items remain explicitly
UNVERIFIED because proving them would have required acting.

**Phase A does not pass.** The readiness matrix stands as follows, and nothing was promoted:

| Level | Verdict |
|---|---|
| L0 | **NOT READY** — the observation path shares a credential that confers un-scoped team execution, and runs cannot be attributed to an initiator |
| L1 | **NOT READY** |
| L2 | **NOT READY** |
| L3 | **NOT READY** |
| L4 | **NOT READY** |

The system's real, verified boundary today is: **the team can read, reason, delegate and propose
pull requests; it cannot manage issues, review, merge or deploy, because those code paths do not
exist.** That boundary is worth keeping and worth stating precisely, because it rests on missing code
rather than on enforced authority. The first P0 item is to make it rest on authority instead.

Phase B was not started, per the directive.
