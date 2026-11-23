---
name: intelligence
description: "Use the Data Intelligence Specialist specialist workflow for providers, ingestion, research, normalization and analytics."
---

# Data Intelligence Specialist skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/intelligence/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Providers, ingestion, research, normalization and analytics.

Owned paths: src/providers.

Required deliverables:
- the provider behaviour measured on the production path with the request and headers quoted
- normalized figures that state their source and timestamp
- a stated uncertainty wherever a number is inferred rather than observed

Handoffs: tdt_architect.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
