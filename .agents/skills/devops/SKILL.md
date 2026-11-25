---
name: devops
description: "Use the DevOps & Release specialist workflow for ci/cd, infrastructure, monitoring and recovery."
---

# DevOps & Release skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/devops/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: CI/CD, infrastructure, monitoring and recovery.

Owned paths: .github, vercel.json, api.

Required deliverables:
- the deployment id and the commit it was built from, matching HEAD
- the health check and the probe that proves the change is live
- a recovery step for every failure that leaves production unhealthy

Handoffs: tdt_hermes.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
