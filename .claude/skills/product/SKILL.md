---
name: product
description: "Use the Product & Research specialist workflow for requirements, scope, priorities and acceptance criteria."
---

# Product & Research skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/product/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Requirements, scope, priorities and acceptance criteria.

Owned paths: team/workflows, team/organization.json, team/ORGANIZATION.md.

Required deliverables:
- acceptance criteria written as observations a tester can check
- an explicit out-of-scope line so the build cannot grow silently
- a priority call when two requests compete for the same budget

Handoffs: tdt_architect.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
