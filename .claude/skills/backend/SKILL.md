---
name: backend
description: "Use the Backend Engineer specialist workflow for backend, database, apis, agents and workflows."
---

# Backend Engineer skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/backend/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Backend, database, APIs, agents and workflows.

Owned paths: src/routes, src/db.

Required deliverables:
- a change behind a pull request on a branch, never on main
- a failing test that reproduces the defect before the fix, and the passing run after it
- the exact request that proves the change on the deployed path

Handoffs: tdt_qa, tdt_sentinel.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
