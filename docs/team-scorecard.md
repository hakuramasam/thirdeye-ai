# Is the team improving? The scorecard

`GET /api/admin/agents/scorecard?hours=168` (master key) compares the last window with the window of equal length before it. Code: `src/agents/scorecard.ts`. Tests: `tests/scorecard.test.ts`, `tests/scorecard-db.test.ts`.

## The six measures

| Measure | Definition | Better |
|---|---|---|
| Task completion rate | delegated tasks that recorded `task.completed`, over delegated tasks | higher |
| First-pass success | jobs whose verify stage passed, with build started once AND no earlier verify failure, over jobs that reached verify | higher |
| Rework rate | distinct job-stage pairs started more than once, over distinct job-stage pairs started | lower |
| Cost per successful run | ALL spend, failed runs included, over successful runs | lower |
| Recovery rate | failed runs followed by a success of the same agent within 26h, over failed runs | higher |
| Open high-severity blockers | unacknowledged `high` alerts, whatever their age | lower (target 0) |

## Rules that keep the score honest

1. **Nothing rewards volume.** No lines of code, pull request count, commits or speed. A busy failing agent ranks below a quiet reliable one. The test checks a named blacklist of volume-shaped metric names; a new metric still needs review.
2. **An unsupported measure says so.** When the ledger cannot support a figure it returns `null` and `not_measurable` with the reason, never 0% or 100%.
3. **Thin samples are labelled.** Every ratio carries `confidence: thin` below five observations.
4. **Team scope applies to every query.** Stage, task and alert rows are filtered to `tdt_` agents exactly as runs are.
5. **An open blocker is open at any age.** The current window counts every unacknowledged high alert.
6. **Failed money is counted.** Cost per success divides all spend by successes only.
7. **A trend needs both ends.** `improving` or `worsening` is claimed only when both windows are measured.

## Production snapshot (2026-11-28, last 30 days)

This is a read-only aggregate snapshot from the production Neon run and audit tables, not a replacement for the live scorecard endpoint.

- Canonical role-agent runs: **45**.
- Successful runs: **19**; failed runs: **26**; success rate: **42.2%**.
- Recorded tool calls: **96**.
- Recorded spend: **$0.030872**.
- HERMES: **22 runs, 4 success, 18 errors**.
- Roles with no runs in the window: PRODUCT, BLOCKCHAIN, INTELLIGENCE and AGENT-ENGINEER.
- Audit events: **256** across **42** correlation IDs.
- Distinct task IDs: **1**; pipeline-ID events: **0**; stage-ID events: **0**.
- Six artifacts were created; one carried a task ID and none carried a pipeline ID.

Some positive specialist samples are old and small: QA 5/5 and DOCS 5/5 (last observed 2026-11-09 and 2026-11-11 respectively), ARCHITECT 2/2 (last observed 2026-11-09). These are not evidence of current continuous readiness.

## What is not measurable yet

First-pass success and rework remain **not measurable** in production because no stage events were recorded in the observed window. The runtime can plan/enforce stages when a caller supplies a pipeline ID, but the production records show that no caller is currently activating this path.

Task completion has only one task ID in the audit snapshot; it is too thin to be treated as a stable completion rate. A task contract is not the same as a durable task queue.

See [the full operational audit](AGENT_TEAM_OPERATIONAL_AUDIT_2026-11-28.md) and [the pipeline status](agent-pipeline.md).
