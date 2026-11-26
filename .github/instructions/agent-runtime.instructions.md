---
applyTo: "src/agents/**,src/team/**,team/agents/**,team/pipelines/**"
---

# Agent runtime and team contracts

Read `team/organization.json`, the matching role skill, `team/policies/authority.md`, `team/tools.json` and `team/resources.json` before changing agent behavior.

- Preserve one accountable owner per pipeline stage, named handoffs and independent QA/SENTINEL verification.
- Every new tool needs a narrow schema, explicit access condition, size/time/spend caps, refusal behavior and tests for both allow and deny paths.
- User-controlled URLs must use the existing SSRF guard. MCP endpoints must be validated before connect and again before each call.
- Preserve delegation depth, run budget, per-step accounting, audit correlation and artifact references.
- Do not widen `repo_write`, money policy, x402 seller allowlists or standing permissions through prompts or platform config.
- A prompt or skill pack is not an authorization control. Enforce authority in server code and test refusals.
