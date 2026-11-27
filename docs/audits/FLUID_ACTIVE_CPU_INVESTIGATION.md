# Vercel Fluid Active CPU Investigation

**Status:** investigation only; no production configuration or application behavior changed.
**Base revision:** `190fd6632450c86edca305e4e6f2b0d3b42879ba`
**Branch:** `diagnostics/vercel-fluid-cpu-attribution`

## Confirmed evidence

- The Vercel Usage screenshot attributes 100.0% of the displayed Fluid Active CPU usage to project `thirdeye-ai`. This is project attribution, not proof that CPU was continuously at 100%.
- The screenshot shows `4h 47m / 4h` Fluid Active CPU and a pause countdown of approximately 28 days and 11 hours.
- `vercel.json` routes `/api/*` to `api/index.ts`, and configures `api/index.ts` as a single Vercel function with 1024 MB memory and 60-second maximum duration.
- `vercel.json` schedules `/api/cron/agents` daily at `0 9 * * *`.
- `src/routes/agents.ts` implements that cron handler. It queries up to 20 active agents with schedules, checks due slots, and runs due agents sequentially. Each run uses the shared invocation deadline.
- `src/agents/runner.ts` supports multi-step model calls, tool calls, and delegated child runs. This makes the cron/runner path a sensible investigation priority, but does not establish that it caused the observed CPU spikes.

## Route-level metric access attempt (2026-11-28)

- Retrieved Vercel's metric catalog and confirmed that `vercel.function_invocation.function_cpu_time_ms` is the documented Function Invocations Active CPU Time metric.
- Attempted read-only Vercel Observability API queries for that metric, grouped by `route`, scoped to the Thirdeye project. The API returned HTTP 400 `bad_request` for both a November 1–28 window and a minimal default-window query. The API response did not expose a more specific validation reason.
- Queried production runtime logs for the latest 50 minutes grouped by `requestPath`; the result contained no rows. This is not evidence that the routes have no traffic; it only means no matching runtime-log records were returned in that window.
- The previous historical runtime-log request was rejected because Hobby retains runtime logs for only one hour.
- Vercel's current Query documentation states that Query is available on Pro and Enterprise, and that Observability Plus is needed to create or modify queries. The team is on Hobby. Therefore the account's plan is a likely access limitation, but the HTTP 400 alone does not prove that is the precise API rejection reason. No upgrade is authorized or recommended under the current no-upgrade constraint.
- The Usage page's project-level Fluid Active CPU graph does not expose a route breakdown in the screenshots supplied.

## Working hypotheses (not findings)

1. The scheduled agent cron may produce concentrated CPU usage if several scheduled agents are due in one tick.
2. Manual agent-run requests may also contribute.
3. Other API handlers may contribute; the shared `api/index.ts` function configuration means the function-level limit alone cannot isolate them.

Do not change cron schedules, agent status, model settings, retries, function limits, project settings, environment variables, secrets, or production data based on these hypotheses.

## Required next evidence

1. Obtain route-level function CPU data from a Vercel Query/Observability view or API entitlement that is available on the current plan, or from an existing owner-controlled telemetry source.
2. Compare CPU time by route with invocation counts, duration, and traffic for the same time window.
3. If historical route attribution cannot be obtained without upgrading, do not upgrade. Instead, prepare a minimal, privacy-safe diagnostic instrumentation proposal on this branch, with tests, and request explicit approval before any deployment.
4. Only after a route is demonstrated to be a material CPU contributor, add a narrowly scoped regression test and targeted fix on this branch.

## Safety boundary

- No production configuration changes.
- No Vercel plan upgrade, new deployment, or redeployment.
- No production data writes or agent dispatches.
- No secret values requested, read, copied, or changed.
- No changes to the existing draft PR #118.
