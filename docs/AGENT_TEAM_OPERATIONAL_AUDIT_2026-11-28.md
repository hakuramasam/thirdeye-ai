# Thirdeye AI development-agent team operational audit — 2026-11-28

## Executive finding

The repository has a coherent 12-role organization, role skill packs, platform adapters, task/message/report schemas, pipeline definitions, an audit log, artifact storage and a guarded PR-only repository write path.

The production team is **not yet a reliably autonomous 12-role engineering organization**. The production database shows real agent runs, but low success, sparse delegation, no production pipeline/stage execution and no durable task queue. The organization is structurally defined; the autonomous operating loop is not yet demonstrated.

## Evidence scope

- Canonical roster and contracts: `team/organization.json`, `team/platforms.json`, `team/pipelines/`, `team/workflows/`, `src/team/schemas/`.
- Structural checks: `tests/organization.test.ts` verifies 12 role entries, one HERMES orchestrator, valid handoff targets, owned paths, skill-pack presence, five code-enforced policy services and independent build/verify/review ownership. It does not execute the agents or prove their competency.
- Runtime source: `src/agents/runner.ts`, `src/agents/pipeline.ts`, `src/agents/audit-log.ts`, `src/agents/artifacts.ts`, `src/agents/repo-write.ts`.
- Production snapshot: read-only Neon queries on 2026-11-28, last 30 days. Aggregates only; no customer IDs, prompts, tool arguments or output text included.

## Production operating metrics

| Measure | Observed value |
|---|---:|
| Active canonical role records | 12 |
| Canonical roles with runs in the 30-day window | 8 |
| Canonical roles with no runs in the 30-day window | 4 |
| Canonical role-agent runs | 45 |
| Successful role-agent runs | 19 |
| Failed role-agent runs | 26 |
| Success rate | 42.2% |
| Recorded tool calls on those runs | 96 |
| Recorded spend | $0.030872 |
| Audit events | 256 |
| Distinct correlation IDs | 42 |
| Distinct task IDs in audit events | 1 |
| Pipeline-ID events | 0 |
| Stage-ID events | 0 |
| Artifact rows created in the window | 7 |
| Artifacts carrying a task ID | 1 |
| Artifacts carrying a pipeline ID | 0 |
| Artifact rows with a matching creation audit event | 6 of 7 |

These are operational counts, not a benchmark of code quality. They include every run recorded for the 12 canonical role IDs during the window.

## Role-by-role activity

| Role | Runs | Success | Error | Assessment |
|---|---:|---:|---:|---|
| HERMES | 22 | 4 | 18 | Active but unreliable; 81.8% of its runs ended in error. It needs failure classification before receiving more authority. |
| ARCHITECT | 2 | 2 | 0 | Positive but very thin sample; last observed run 2026-11-09. |
| PRODUCT | 0 | 0 | 0 | No production run evidence. |
| BACKEND | 3 | 1 | 2 | Not reliable yet; failure/recovery work required. |
| FRONTEND | 2 | 0 | 2 | No successful run in the observed window. |
| BLOCKCHAIN | 0 | 0 | 0 | No production run evidence. |
| INTELLIGENCE | 0 | 0 | 0 | No production run evidence. |
| AGENT-ENGINEER | 0 | 0 | 0 | No production run evidence. |
| QA | 5 | 5 | 0 | Positive historical sample, but thin and last observed 2026-11-09. |
| SENTINEL | 3 | 1 | 2 | Independent review capability is not yet reliable in production. |
| DEVOPS | 3 | 1 | 2 | Needs failure/recovery work. |
| DOCS | 5 | 5 | 0 | Positive historical sample, but last observed 2026-11-11. |

HERMES had a daily cron expression (`0 9 * * *`) but its latest recorded run was 2026-11-25. Of its 18 failed runs, 13 are classified as rate-limit failures and five as other; the exact upstream cause for the rate-limit group still needs diagnosis. This snapshot does not show a later successful scheduled run. A separate legacy `Elio cron probe` generated 11 failed, artifact-related `read_artifact` tool events; it is not one of the 12 canonical roles and should not be counted as team delivery.

## What is implemented versus what is operational

| Capability | Code / contract state | Production evidence |
|---|---|---|
| 12 canonical role definitions and skills | Present; structural tests pass | 12 active role records exist |
| HERMES delegation | Tool and policy exist; HERMES has delegation enabled | One delegated-task audit event; only one distinct task ID; a `delegate_to_agent` tool event is marked refused in run-event telemetry. Not evidence of sustained reliable handoffs. |
| Task contract | JSON Schema exists and is validated before a handoff | No `agent_tasks` table in the production schema; the runner constructs a task object in memory. Durable queue, lease, retry and resume are not implemented. |
| Pipeline definitions | Feature, bugfix and incident JSON definitions exist and tests validate their structure | Zero production pipeline-ID or stage-ID events in the last 30 days. |
| Runtime stage planning | `planForPipeline` and stage-ledger checks exist in the runner | Dormant unless a caller supplies a pipeline ID; production has no evidence that callers do so. |
| Correlation-aware audit | Append-oriented `agent_audit_events` and run/tool events exist | 256 audit events and 42 correlations in the observed window. |
| Addressable artifacts | Artifact registry, content hash, version and read-window API exist | Six artifacts created; only one had a task ID and none had a pipeline ID. |
| QA and SENTINEL gates | Pipeline stages and role packs define independent responsibilities | No production pipeline-stage evidence; independent approvals on a fixed SHA are not a routine demonstrated gate. |
| Repository write | PR-only tool, `agent/*` branch validation, path allowlist, secret scan and protected control-plane/money paths | HERMES's production agent row has persistent `repo_access=write`; see authority finding below. |

## Authority and safety finding

Production has one canonical agent with `repo_access=write`: HERMES. The runner exposes `repo_write` when either the run has `allowWrite=true` **or** the agent row has `repo_access='write'`. The policy describes task-scoped grants and says persisted write entitlements are high risk and require owner approval.

The repository write tool still has valuable restrictions: it writes only to `agent/*` branches, limits files and bytes, blocks credentials, blocks money/key/schema and control-plane paths, opens a pull request and cannot merge. Those controls reduce impact but do not make a standing entitlement equivalent to a task-scoped grant.

**Recommendation:** owner-review HERMES's persistent write entitlement and move to read-only by default; grant write only to a specific approved task/run. No database permission was changed in this audit.

## Main operational blockers

1. **HERMES reliability:** 18 of 22 runs failed. Classify failure codes and root causes before increasing delegation, spend or write authority.
2. **No durable task system:** task IDs are generated in the runner and events are recorded, but there is no production task table/queue for leases, idempotency, retries, cancellation, resume or task-level audit state.
3. **Pipelines are dormant:** the runner only enforces the next stage when a caller supplies a pipeline ID and the model chooses the delegation (no caller-pinned stage). Production has zero pipeline/stage events.
4. **Handoff and artifact evidence is weak:** only one task ID and one delegated-task event exist in the 30-day snapshot. Eleven artifact-read failures were recorded for the legacy probe, and one of seven artifact rows has no matching `artifact.created` audit event; reconcile this audit gap.
5. **Specialists are idle or stale:** PRODUCT, BLOCKCHAIN, INTELLIGENCE and AGENT-ENGINEER have no run evidence; several successful QA/DOCS/ARCHITECT samples are more than two weeks old.
6. **Independent acceptance is not systematic:** QA and SENTINEL have role packs, but there is no repeated evidence of separate QA and security approvals on the same immutable PR SHA.
7. **Scheduled execution is not proven:** HERMES's last recorded run is 2026-11-25 despite its daily cron expression. The platform cron is daily; finer schedules depend on an external pinger.
8. **Competency tests are structural, not behavioral:** the current organization tests validate the chart, files and ownership contracts. They do not run the 12 role challenges, adversarial/refusal tests or realistic handoff exercises.

## Required autonomous operating frame

Use this as the acceptance architecture for the next implementation phase:

1. **HERMES intake:** create a durable task row with idempotency key, objective, owner, acceptance criteria, risk and deadline.
2. **Plan pinning:** select a declared pipeline and persist `pipeline_id`, current `stage_id`, attempt and dependency state before a specialist is invoked.
3. **Bounded specialist assignment:** hand one task to the stage owner with only the required tools, budget and task-scoped write grant.
4. **Durable evidence:** specialist produces a versioned artifact with task, pipeline, stage, run and correlation IDs. Artifact reads must be tested from a different run.
5. **Independent QA:** QA runs acceptance tests against the exact artifact/PR SHA; builder cannot approve its own work.
6. **Independent SENTINEL:** security reviewer examines the same immutable SHA and records findings separately from QA.
7. **HERMES synthesis:** HERMES checks that required artifacts and approvals exist; it does not invent missing approvals or bypass failed gates.
8. **Owner-only release:** merge, production deployment, production secrets, financial actions and standing permission changes remain human-approved.
9. **Operational metrics:** publish task completion, handoff success, artifact-read success, stage coverage, first-pass success, rework, recovery, cost per accepted task and age of blocked tasks.

## Recommended implementation order

- **P0:** classify HERMES failures; fix artifact-read failures; verify the cron dispatch path; remove standing write authority after owner approval.
- **P1:** implement durable task storage/leases/retries/resume; make pipeline ID and stage assignment mandatory for development-team work; enforce separate QA and SENTINEL approval on the same SHA.
- **P1:** run 12 competency challenges (normal, edge, malicious, refusal, tool unavailable, budget exhausted, stale artifact, wrong SHA, failed test, conflicting instruction, secret exposure, unauthorized action).
- **P2:** expose a task board and team scorecard with evidence-backed state, not just agent status labels.

## Acceptance gate for claiming autonomy

Do not call the team autonomous until a real non-production task completes end to end with: durable task row → HERMES plan → specialist handoff → versioned artifact → independent QA → independent SENTINEL on the same SHA → owner-approved PR. The entire chain must be reconstructable from one correlation ID, and all spend and write permissions must stay inside the approved cap.
