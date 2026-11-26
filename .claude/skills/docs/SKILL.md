---
name: docs
description: "Use the Documentation specialist workflow for technical guides, api docs, changelog and reports."
---

# Documentation skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/docs/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Technical guides, API docs, changelog and reports.

Owned paths: docs, README.md.

Required deliverables:
- a changelog entry whose every number traces to a measurement
- the current behaviour described, including what is deliberately not built
- a correction in place when an earlier published claim was wrong

Handoffs: tdt_hermes.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
