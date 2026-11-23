# Runtime skill rollout and competency evaluation

## Runtime behavior

The runner resolves only the twelve allowlisted team roles from `team/agents/<role>/SKILL.md`. The role pack is appended to the existing database `system_prompt`; it does not replace the base prompt or change tool permissions. Ordinary user-created agents do not receive a team pack.

Every run stores `skill_version` and `skill_sha256` on `agent_runs`. The run-created audit event records the same values. Run history exposes the version and hash. The serverless function bundles `team/agents/**` so runtime file loading does not depend on an untracked local file.

## Rollback

- Immediate global prompt rollback: set `THIRDEYE_AGENT_SKILLS_ENABLED=false` in the runtime environment and redeploy/restart the application. The original database `system_prompt` remains unchanged.
- Code rollback: redeploy the last known-good application commit before the skill-loader change. Each run retains the exact skill version/hash used, so the history remains attributable.
- Do not edit agent prompts in bulk as a rollback mechanism; preserve their original values.
- After rollback, run one smoke test and verify the new run has null `skill_version` and `skill_sha256`.

## Competency challenge design

`team/competency-scenarios.json` defines four tests for each of the twelve roles: normal execution, difficult edge case, malicious-instruction resistance, and explicit refusal of unauthorized merge/deploy/financial actions. The live harness submits one bounded, read-only run per role and retrieves redacted evidence from the protected cron evidence endpoint.

Dry run (no agent invocation):

```sh
npm run evaluate:agents
```

Live run requires all of the following, and intentionally refuses to start without a positive total spend cap:

- `THIRDEYE_BASE_URL`: deployed ThirdEye API origin.
- `THIRDEYE_CRON_SECRET`: the existing cron bearer secret; never commit it.
- `THIRDEYE_AGENT_IDS_JSON`: JSON object mapping each `tdt_*` role ID to its actual database agent row ID.
- `THIRDEYE_EVAL_MAX_TOTAL_SPEND_USD_MICROS`: explicit aggregate spend ceiling in USD micros.

Then run:

```sh
node scripts/run-agent-competency.mjs --live
```

The harness runs sequentially, stops after the configured aggregate spend cap is exceeded, and writes output plus redacted run/tool/audit evidence under `artifacts/competency/`. It does not assign a graduation status. Human QA and SENTINEL review of the exact skill SHA and evidence remains mandatory. A role is not verified merely because the run succeeded or the agent claimed success.

## Authority boundary

Competency evidence does not grant GitHub merge authority, production release authority, security-policy administration, financial approval, signing authority or fund movement. Those controls remain separate and owner-gated.
