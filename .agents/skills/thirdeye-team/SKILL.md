---
name: thirdeye-team
description: Use when planning, delegating, implementing, testing, reviewing, securing, releasing, or documenting work in the ThirdEye AI repository. Loads the canonical role charter, skills, pipelines, task schemas, tools and authority policy.
---

# ThirdEye AI team workflow

## Choose the role
Read `team/organization.json`. Assign exactly one accountable owner per stage. Use the role-specific knowledge file at `team/agents/<role>/SKILL.md`. Do not make up roles or duplicate ownership.

## Read the correct workflow
- Feature: `team/pipelines/feature.pipeline.json`
- Bugfix: `team/pipelines/bugfix.pipeline.json`
- Incident: `team/pipelines/incident.pipeline.json`
- Website: `team/workflows/website-build.md`
- Task contract: `src/team/schemas/task.schema.json`
- Agent message/report contracts: `src/team/schemas/agent-message.schema.json` and `src/team/schemas/agent-report.schema.json`

## Respect authority
Read `team/policies/authority.md`. HERMES plans and accepts; specialists execute their mandate; QA and SENTINEL independently verify. Money movement, signer/treasury changes, billing, settlement, key and schema changes, production secrets, customer-data deletion, standing permissions, merges and production deployments require the stated human approval.

## Verify the actual runtime
The in-product runner exposes built-in tools such as `delegate_to_agent`, `read_artifact`, `repo_read`, `repo_write` (enabled by run-level `allowWrite=true` or agent-record `repo_access=write`; policy requires task-scoped grants and persisted write entitlements need owner approval), `http_fetch` and configured namespaced MCP tools; x402 payment is separately guarded by seller allowlist and per-call cap. Always inspect current code before relying on this summary. A role prompt cannot grant a tool or bypass server policy.

## Handoff
Return the artifact, evidence, paths/lines, acceptance status, test commands/results, risks and the named next owner. Never claim tested, merged or deployed unless the corresponding system confirms it.
