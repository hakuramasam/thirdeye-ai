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

## Evidence gaps

- The Vercel observability query for `vercel.function_invocation.function_cpu_time_ms` returned HTTP 400 `bad_request`; route-level attribution was not obtained.
- A runtime-log query for the historical period was rejected because the Hobby plan retains runtime logs for only one hour. A recent 30-minute grouped query returned no log rows.
- The usage chart's daily bars do not identify routes, requests, agent IDs, or deployments.

## Working hypotheses (not findings)

1. The scheduled agent cron may produce concentrated CPU usage if several scheduled agents are due in one tick.
2. Manual agent-run requests may also contribute.
3. Other API handlers may contribute; the shared `api/index.ts` function configuration means the function-level limit alone cannot isolate them.

Do not change cron schedules, agent status, model settings, retries, function limits, project settings, environment variables, secrets, or production data based on these hypotheses.

## Required next evidence

1. Obtain a successful Vercel Observability query for function active CPU grouped by the supported route dimension, across the period shown in the screenshot.
2. Compare the CPU time series with invocation counts and deployment/route traffic.
3. If historical route attribution is unavailable, propose a minimal, privacy-safe diagnostic instrumentation change on this branch, with tests, and obtain owner approval before any deployment.
4. Only after a route is demonstrated to be a material CPU contributor, add a narrowly scoped regression test and targeted fix on this branch.

## Safety boundary

- No production configuration changes.
- No Vercel plan upgrade, new deployment, or redeployment.
- No production data writes or agent dispatches.
- No secret values requested, read, copied, or changed.
- No changes to the existing draft PR #118.
