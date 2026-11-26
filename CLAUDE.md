# ThirdEye AI — Claude Code project guidance

Follow the repository-wide `AGENTS.md` contract. It is the primary source for team authority, safety, pipelines and verification.

Before acting, load:
- `team/organization.json`
- Your role's `team/agents/<role>/SKILL.md`
- `team/policies/authority.md`
- The applicable `team/pipelines/*.pipeline.json` and `team/workflows/` references

Use the `thirdeye-team` skill in `.claude/skills/thirdeye-team/SKILL.md` for role selection and handoff. Do not duplicate role knowledge in this file.

Claude Code tools and local workspace permissions are controlled by the host. This file does not grant GitHub, Neon, Vercel, Cloudflare, MCP, production, payment or merge access. The in-product `repo_write` tool is gated by run-level `allowWrite` or the agent record's `repo_access=write`; policy requires task-scoped grants and persisted write entitlements need explicit owner approval. Never treat local file-edit permission as the in-product task-scoped `repo_write` grant.

No agent merges or deploys production autonomously. Money, signer, billing, settlement, key, schema, production-secret, customer-data and standing-permission changes must follow `team/policies/authority.md` and obtain owner approval.
