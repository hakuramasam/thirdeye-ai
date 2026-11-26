# Is the team improving? The scorecard

`GET /api/admin/agents/scorecard?hours=168` (master key) compares the last window with the window of equal
length before it. Code: `src/agents/scorecard.ts`. Tests: `tests/scorecard.test.ts`, `tests/scorecard-db.test.ts`.

## The six measures

| Measure | Definition | Better |
| --- | --- | --- |
| Task completion rate | delegated tasks that recorded `task.completed`, over delegated tasks | higher |
| First-pass success | jobs whose verify stage passed, with build started once AND no earlier verify failure, over jobs that reached verify | higher |
| Rework rate | distinct job-stage pairs started more than once, over distinct job-stage pairs started | lower |
| Cost per successful run | ALL spend, failed runs included, over successful runs | lower |
| Recovery rate | failed runs followed by a success of the same agent within 26h, over failed runs | higher |
| Open high-severity blockers | unacknowledged `high` alerts, whatever their age | lower (target 0) |

## Rules that keep the score honest

1. **Nothing rewards volume.** No lines of code, pull request count, commits or speed. A busy failing agent
   ranks below a quiet reliable one. What the test actually does: it asserts the six measure ids and labels
   contain none of a fixed list of volume-shaped names, and that the per-agent output exposes no `runs`
   field. It is a named blacklist, not a proof, so a new metric with an unlisted name would need review.
2. **An unsupported measure says so.** When the ledger cannot support a figure it returns `null` and
   `not_measurable` with the reason, never 0% and never 100%. Both would be believed.
3. **Thin samples are labelled.** Every ratio, including each agent's success rate, carries
   `confidence: thin` below five observations, so "100%" over one task reads as a fact, not a rate.
4. **Team scope applies to every query.** Stage, task and alert rows are filtered to `tdt_` agents exactly
   as runs are, so a legacy agent cannot move a team measure.
5. **An open blocker is open at any age.** The current window counts every unacknowledged high alert; the
   previous window is evaluated as of its end time, so a long-lived blocker cannot manufacture a trend.
6. **Failed money is counted.** Cost per success divides all spend by successes only.
7. **A trend needs both ends.** `improving` or `worsening` is claimed only when both windows are measured.

## What the first live reading showed (2026-11-15, 34 team runs)

- 4 of 6 measures backed by the ledger, 2 not measurable.
- Cost per successful run $0.001266 (24,052 µ$ over 19 successes), so failed spend is about a fifth of the total.
- Recovery 6 of 15 (40%). HERMES succeeded 4 of 11 runs, FRONTEND 0 of 2, QA 5 of 5, DOCS 5 of 5.
- Task completion 1 of 1, flagged thin.
- First-pass success and rework: **not measurable**, because zero `stage.*` events exist in production.

## The gap behind the two unmeasurable measures

The runner records stage transitions and enforces stage order when a run carries a `pipelineId`, but no caller
ever supplied one, so that machinery was dormant. The ops path now accepts `pipeline_id` (a declared id or a
400), which is what switches stage recording on. Until real jobs run through a pipeline, first-pass and
rework stay not measurable, and the scorecard will keep saying so.
