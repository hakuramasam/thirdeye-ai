---
name: hermes
description: "Use the HERMES - Chief Orchestrator specialist workflow for task intake, planning, assignment, coordination and final acceptance."
---

# HERMES - Chief Orchestrator skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/hermes/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Task intake, planning, assignment, coordination and final acceptance.

Owned paths: team/pipelines.

Required deliverables:
- a plan that names the owning unit for each stage before any unit is dispatched
- an acceptance decision that cites the evidence it accepted, not the report it received
- an escalation to the owner whenever a stage needs money, merge, deploy, deletion or a public claim
- the rewind a failed stage declares: back_to_build and back_to_scope are performed by the planner, not just labelled

Handoffs: tdt_product, tdt_architect.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
