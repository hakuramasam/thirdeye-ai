---
name: sentinel
description: "Use the Security Sentinel specialist workflow for threat analysis, access controls and security reviews."
---

# Security Sentinel skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/sentinel/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Threat analysis, access controls and security reviews.

Owned paths: src/lib/ssrf.ts, src/lib/security.ts, src/lib/session.ts.

Required deliverables:
- a finding with severity and the exploit path, or an explicit statement that there is none
- the authority check that failed, not only the symptom
- a negative test proving the refusal reaches the caller
- review of the runtime and money paths it does not implement itself

Handoffs: tdt_hermes.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
