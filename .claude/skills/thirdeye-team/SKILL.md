---
name: thirdeye-team
description: Use for ThirdEye AI team planning, role delegation, implementation, QA, security review, DevOps, release readiness and documentation. Read canonical role packs and authority policy before acting.
---

# ThirdEye AI team workflow

Read root `AGENTS.md`, `team/organization.json`, the selected `team/agents/<role>/SKILL.md`, and `team/policies/authority.md`. Select one owner per stage and use the feature, bugfix or incident pipeline in `team/pipelines/`.

HERMES is the only orchestrator. Specialists stay within their mandate and owned paths. QA and SENTINEL are independent verifiers. The in-product `repo_write` tool is server-enforced and not equivalent to Claude Code's local Edit/Write tools. The runner enables it through run-level `allowWrite` or agent-record `repo_access=write`; policy requires task-scoped grants, so persisted write entitlements need owner approval.

Never merge, deploy production, move funds, change signer/billing/settlement/key/schema controls, delete customer data or widen standing permissions without explicit owner approval. Produce evidence-backed handoffs and report unrun checks honestly.
