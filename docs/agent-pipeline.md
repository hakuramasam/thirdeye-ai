# Agent pipelines: declared, enforced in code, not yet active in production

**Status snapshot: 2026-11-28.** The pipeline design is no longer merely a document, but it is not yet a proven production workflow.

## Canonical definitions

Pipeline definitions live in `team/pipelines/*.pipeline.json` and are checked by `tests/pipelines.test.ts`. They declare stages, owners, gates, artifacts, dependencies, environments and owner approval before production release.

The task, agent-message and agent-report contracts live in `src/team/schemas/`. The task schema is validated before the runner attempts a delegation.

## Runtime behavior

The current runner imports `planForPipeline`, reads the stage ledger, records stage transitions and carries correlation, task, pipeline and stage identifiers into delegated child runs.

- Pipeline enforcement is active only when the caller supplies a `pipelineId`.
- When the model chooses a delegation and no caller-pinned stage is supplied, the runner asks `planForPipeline` for the next permitted stage and rejects a wrong owner or unmet dependency.
- A caller-pinned stage is treated as an explicit driver decision: the runner records the stage but does not independently select the next stage.
- Handoffs validate the task contract and fail closed if the delegation audit event cannot be written.
- Artifacts are stored with IDs, versions, content hashes and task/pipeline/stage references; the HTTP artifact API is owner-scoped and supports bounded reads.

This is materially different from the earlier state where stage order and artifact content existed only in prose.

## What remains incomplete

1. **No durable task queue:** the runner constructs and validates a task object in memory. The production schema has no `agent_tasks` table, so there is no durable task lifecycle, lease, retry, cancellation or resume mechanism.
2. **No production pipeline activation:** read-only production telemetry for the last 30 days shows 0 pipeline-ID events and 0 stage-ID events.
3. **No evidence of sustained handoffs:** the same window shows one distinct task ID and one delegated-task audit event; that is not enough to claim a reliable multi-agent workflow.
4. **Artifact traceability is sparse:** six artifacts were created, only one had a task ID, and none had a pipeline ID in the observed window.
5. **The caller is part of the trust boundary:** because the caller can pin a stage, the dispatch endpoint must own pipeline selection and validate that the requested stage is the next stage. Do not let a model or untrusted client choose arbitrary stage IDs.
6. **Independent acceptance is not operationalized:** QA and SENTINEL must review the same immutable PR SHA and produce separate records before a release can be considered.

## Production evidence snapshot (2026-11-28)

Read-only Neon aggregate queries over the last 30 days:

- 45 runs for the 12 canonical role agents: 19 successful, 26 failed (42.2%).
- 256 audit events across 42 correlation IDs.
- One distinct task ID, zero pipeline-ID events and zero stage-ID events.
- Six artifacts created; one linked to a task and none linked to a pipeline.

The full role-by-role analysis is in [the agent-team operational audit](AGENT_TEAM_OPERATIONAL_AUDIT_2026-11-28.md).

## Current mapping

| Capability | State |
|---|---|
| Pipeline JSON definitions and structural validation | Implemented |
| Task/message/report JSON schemas | Implemented |
| Runtime next-stage planner | Implemented |
| Runtime stage-owner/dependency check | Implemented when pipeline ID is supplied and stage is not caller-pinned |
| Correlation-aware audit events | Implemented |
| Addressable artifact storage and bounded reads | Implemented |
| Durable task queue, leases, retries and resume | Not implemented |
| Mandatory pipeline dispatch for development tasks | Not implemented |
| Production pipeline/stage usage | No evidence in the observed 30-day window |
| Independent QA + SENTINEL approvals on one SHA | Defined, not yet routine/proven |
| Owner-only merge/deploy release gate | Required by policy |

## Acceptance test for the next phase

A non-production task must complete through a real dispatch endpoint and durable task row. The runner must pin a pipeline, assign only the next stage owner, persist the stage transition, store an artifact with task/pipeline/stage IDs, and let independent QA and SENTINEL review the same fixed SHA. Missing artifacts, failed tests, stale SHAs, failed audit writes, budget exhaustion or unauthorized write requests must stop the task rather than produce a success report.
