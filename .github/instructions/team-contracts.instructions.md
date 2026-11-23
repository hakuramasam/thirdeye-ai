---
applyTo: "team/**,docs/**"
---

# Team knowledge and documentation

- Keep `team/organization.json` as the machine-readable roster and ownership source.
- Every role has one canonical `team/agents/<role>/SKILL.md`; platform adapters reference these packs instead of forking their content.
- Keep `team/tools.json` and `team/resources.json` aligned with actual runtime code and real paths.
- Pipeline owners, stage artifacts, gates and next handoffs must agree with `team/pipelines/` and the JSON schemas.
- Separate implemented behavior from planned gaps. Date measured numbers and cite evidence.
- Do not document a provider, MCP endpoint, secret or integration as active unless its configuration and live behavior are verified.
