# ThirdEye AI — Gemini CLI project context

Follow `AGENTS.md` as the repository-wide operating contract. Do not create a second team charter.

Load canonical role knowledge from:
- `team/organization.json` — roster, mandates, paths, handoffs and deliverables
- `team/agents/<role>/SKILL.md` — role-specific operating procedure
- `team/policies/authority.md` — authority and escalation boundaries
- `team/pipelines/` and `team/workflows/` — execution plans and gates

Use default tool confirmation. Do not use YOLO mode for this repository. Treat MCP servers as external capabilities: only use explicitly configured servers, verify their tool schemas and host allowlists, and never assume a tool exists because a prompt mentions it. In-product `repo_write` is gated by run-level `allowWrite` or the agent record's `repo_access=write`; policy requires task-scoped grants, so persisted write entitlements require owner approval.

Never merge, deploy production, move funds, change signers, alter billing/settlement/keys/schema, delete customer data or widen standing permissions without explicit owner approval. An agent report is not evidence of a successful test, merge or deployment.
