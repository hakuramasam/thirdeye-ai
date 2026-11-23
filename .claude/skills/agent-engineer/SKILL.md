---
name: agent-engineer
description: "Use the Agent Runtime Engineer specialist workflow for agent runtime, tool contracts, scheduling and execution accounting."
---

# Agent Runtime Engineer skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/agent-engineer/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Agent runtime, tool contracts, scheduling and execution accounting.

Owned paths: src/agents.

Required deliverables:
- a runtime change proved against a real run, not only a unit test
- the spend and tool counts on the run row after the change
- a named failure mode for every new retry, timeout or abort path

Handoffs: tdt_qa, tdt_devops.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
