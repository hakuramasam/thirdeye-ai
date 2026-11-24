---
name: qa
description: "Use the QA & Testing specialist workflow for reproduction, testing, regression and evidence."
---

# QA & Testing skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/qa/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Reproduction, testing, regression and evidence.

Owned paths: tests.

Required deliverables:
- the failing command and its output before the fix, captured verbatim
- every acceptance criterion marked met or unmet, each with the evidence that decided it
- the suite count after the change

Handoffs: tdt_sentinel.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
