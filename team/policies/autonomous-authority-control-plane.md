# Autonomous authority control plane

Status: proposed policy and implementation contract. This document does not itself grant runtime permissions, change GitHub protection, configure Vercel, expose secrets, or authorize financial operations.

## Governing rule

A successful test or CI run is a technical evidence event, not universal acceptance.

- A passing required CI check may satisfy only the CI sub-gate for the exact commit it tested.
- It may unlock the next automated evaluation step.
- It does not, alone, establish financial acceptance, security acceptance, production readiness, or owner approval.
- Evidence cannot be reused for another SHA, repository, environment, workflow, or materially changed artifact.
- Missing, stale, skipped, cancelled, neutral, unknown, or unverifiable evidence is not a pass.

The evaluator returns ELIGIBLE, BLOCKED, or EXPIRED. It never silently converts a test result into a broader permission.

## Authority classes

| Capability | Automation policy | Hard boundary |
|---|---|---|
| Repository read | Automatic for registered identities | Least privilege |
| Task-scoped branch write | Automatic after identity, task and path checks | Never write default branch; protected paths require separate review |
| Open/update PR | Automatic after task-scoped write | Does not imply merge |
| Low-risk PR merge | Possible only after HERMES graduation and every merge gate | Exact-SHA CI, independent approval, active branch rules, no protected paths |
| Preview deployment | May be automated in isolated preview | No production credentials or customer funds |
| Production deployment | Deny by default; protected deployment controller only | Explicit owner approval for exact artifact and environment |
| Production secrets | No raw agent access; brokered operation-scoped injection only | Never reveal to model context, logs, artifacts or memory |
| Bounded financial operations | Only after financial acceptance and explicit capability limits | Allowlist, caps, expiry, idempotency, finality, reconciliation and kill switch |
| Financial acceptance | Evaluator may assemble evidence only | Independent financial and security review plus owner approval |
| Unrestricted financial operations | Prohibited | No autonomous grant exists |

Unrestricted financial operations are not an available autonomous permission tier. Replace them with explicit bounded capabilities, each naming amount, asset, chain, contract, recipient, frequency, aggregate cap, expiry and emergency stop.

## Agent role-to-decision matrix

| Agent | Owns / may decide | Must not approve |
|---|---|---|
| HERMES / orchestrator | Decomposition, assignment, sequencing, task grants, gate orchestration, routine closure | Its own escalation, financial acceptance, security sign-off, production release |
| Product | Acceptance criteria, scope, user journey and priority | Technical, security or financial gates |
| Architect | Architecture, interfaces, migration and rollback design | Its own implementation or release |
| Backend | Backend implementation within assigned paths | Independent QA, security or financial acceptance |
| Frontend | UI implementation within assigned paths | Auth, security or financial acceptance |
| Agent engineer | Agent runtime, tools, schemas and delegation implementation | Its own authority policy or security approval |
| Blockchain | Chain/payment design and technical review | Independent financial approval of its own work |
| Sentinel | Adversarial security review, abuse cases and negative tests | Approval of changes it authored; financial approval |
| QA | Independent test design and execution | Approval of code it authored |
| DevOps | CI, preview, release readiness, rollback and deployment observation | Its own production authorization or secret grant |
| Intelligence | Research, monitoring and model/provider evaluation | Billing, secrets, production or financial approval |
| Docs | Documentation and evidence traceability | Technical or financial acceptance |

Unknown or unregistered agents default to read-only. A role may recommend an out-of-scope decision but cannot execute or approve it.

## Gate model

### G0 — Identity and scope
Authenticated identity maps to a registered agent and role. Task ID, parent run, correlation ID, repository, branch, allowed paths and expiry are present. No identity ambiguity, impersonation, self-delegation or prompt-based policy override.

### G1 — Technical evidence
Required named workflows complete successfully on the exact current head SHA. No required check is skipped, cancelled, neutral, missing or stale. Workflow definitions must come from the protected base, not from an untrusted candidate change that weakens the gate. Relevant unit, integration, concurrency, security and migration tests are included. Record run IDs, workflow IDs, timestamps and artifact digests.

### G2 — Independent review
Reviewer is distinct from author, agent, parent orchestrator and requester; has sufficient repository permission; and reviewed the exact current SHA. Risk-matched reviewers are required: QA for behavior, Sentinel for security, Blockchain/financial specialist for payment code. A review comment or agent report is not an approval.

### G3 — Operational readiness
Preview deployment is isolated and serves the exact candidate SHA. Smoke tests, rollback plan, monitoring, data migration and compatibility checks are recorded. Production environment approval is separate from preview success. Unresolved critical/high findings or failed rollback rehearsal block release.

### G4 — Financial acceptance
For payments, credits, billing, settlement, treasury, refunds, revshare and paid agent actions:
- Real PostgreSQL integration tests on exact SHA, including concurrency, idempotency, rollback, duplicate/replay, reorg/finality and append-only audit behavior as applicable.
- Independent financial-domain reviewer who did not author the change.
- Independent security reviewer for authorization, identity, replay, custody and abuse controls.
- Reconciliation evidence, accounting invariants, failure recovery and bounded exposure documented.
- Human owner approval explicitly tied to exact SHA and evidence digest.
- Green CI is necessary where configured, but never sufficient.

### G5 — Permission issuance
Issue only the narrow capability for which every required gate passed. Grant includes scope, resource, maximum amount if relevant, rate limit, expiry, revocation condition and evidence digest. Grants are short-lived, task-bound and revoked on SHA change, policy change, incident, failed monitoring or expiry. Grant/revoke is append-only audited and fails closed if audit persistence is unavailable.

## Auto-merge policy

Auto-merge is eligible only when:
1. Active branch protection/rulesets require PR review, current CI and up-to-date branches.
2. PR is low risk and changed paths are allowlisted.
3. Required CI and tests pass on the exact latest head SHA.
4. Qualified independent human approval exists on that exact SHA.
5. No unresolved review thread, requested changes, conflict, stale base or failing check exists.
6. Merge controller re-fetches and revalidates SHA immediately before merge.
7. Merge event is audited and rollback/forward-fix owner assigned.

Deny auto-merge for payments, settlement, billing, auth, keys, secrets, schema, GitHub workflows, authority policies, deployment config, treasury and wallet signer paths unless a separate risk-specific owner policy is configured. HERMES cannot create that exception.

## Production deployment

Normal flow: build, test, preview, verify, prepare release record, request production authorization. A protected deployment controller may promote only when approved artifact digest and SHA match preview, all quality/security/operational gates are fresh, environment protection requires a separate approver, rollback and health verification are ready, and a time-bounded release authorization names target environment and artifact.

Agents may deploy to ephemeral preview environments. They cannot create or approve their own production authorization. Production deployment remains disabled until the owner explicitly enables a protected policy.

## Production secrets

Agents never receive raw production secrets as model-visible text. A secrets broker may inject a named secret into a trusted runtime process only when identity, task, environment and operation are allowlisted; credential is scoped, short-lived and non-exportable; logs/artifacts redact values; access is audited without storing the secret; and revocation/rotation exist.

No CI pass grants secret access. No agent may create, reveal, rotate or expand its own secret scope. Secret administration remains owner/security-controlled.

## Financial capabilities

Use specific capabilities such as credit.quote.read, credit.deposit.verify, credit.deposit.settle, credit.refund.propose, credit.refund.execute, x402.pay, treasury.read and treasury.transfer.propose.

Every executable capability specifies allowed agent/task classes, chain, token, contract, recipient/seller, per-call/per-run/daily limits, idempotency, finality, independent authorization, emergency stop, reconciliation and owner. No wildcard recipient, unlimited cap, indefinite grant or self-approved refund/transfer. Financial acceptance is specific to an implementation and SHA; it never grants unrestricted financial power.

## Evidence and tracking fields

Every evaluation records:
- evaluation_id, correlation_id, run_id, parent_run_id, task_id, workflow_id, stage_id
- agent_id, agent_role, agent_version, requested_capability, resource_scope, environment
- risk_tier, risk_reasons, repository, branch, head_sha, base_sha, changed_paths_digest
- workflow_run_ids, required_check_names, check_conclusions, test_artifact_digests
- postgres_version, database_mode, preview_deployment_id, preview_sha, smoke_result
- reviewer_ids, reviewed_sha, review_decisions, security_report_id, financial_report_id
- owner_approval_id, owner_approved_sha, owner_approval_scope
- decision, blocker_codes, evidence_digest, grant_id, grant_scope, max_amount, rate_limits
- created_at, expires_at, revoked_at, revocation_reason, audit_event_id, policy_version

Do not store credentials, private keys, raw signatures, session tokens or plaintext BYOK values.

## State machine and fail-closed rules

REQUESTED -> CLASSIFIED -> EVIDENCE_PENDING -> TECHNICAL_PASS -> INDEPENDENT_REVIEW -> DOMAIN_ACCEPTANCE -> OWNER_APPROVAL -> GRANTED -> EXPIRED/REVOKED.

Any failed or missing prerequisite becomes BLOCKED with a machine-readable reason. Evidence or head SHA changes invalidate downstream approvals and return the request to EVIDENCE_PENDING.

Evaluator must be deterministic for the same policy/evidence; use immutable identifiers, not branch names alone; reject stale evidence and untrusted check-name collisions; verify workflow provenance; fail closed on audit/API errors, missing reviewers or ambiguous roles; never accept the evaluated agent's own statement as proof; and support immediate owner revocation and incident kill switch.

## Rollout

1. Observe-only: emit evaluations and blocker reasons; issue no new grants.
2. Low-risk task grants: read and task-scoped branch write after G0 and path policy.
3. Low-risk auto-merge pilot: only after B1-B5 merged, exact-SHA verifier passes, independent approvals exist and active branch rules enforce the gates.
4. Preview automation: ephemeral previews only; production promotion owner-gated.
5. Bounded financial capabilities: only after WO-02 G4 acceptance; begin with read/quote/verify, execution later.
6. Production secrets: brokered operation-level access only; never raw model-context exposure.
7. Production release automation: separate protected controller and explicit owner enablement.

## Current state

As of this policy change, HERMES Phase B is not graduated; WO-02 is not financially accepted; agent production deployment, automatic merging, raw production-secret access and unrestricted financial operations remain disabled. This document is a proposed contract, not evidence of runtime enforcement.
