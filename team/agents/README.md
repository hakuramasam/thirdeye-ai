# Thirdeye agent capability packs

One file per agent, readable at runtime through `repo_read` at `team/agents/<role>/SKILL.md`.

Adding a role means adding a folder here and pointing its `system_prompt` at it, so the knowledge travels with the repository rather than living only in a database row.

Every pack ends with the same pointer to `team/operating-spec/MASTER-OPERATING-SPEC.md`, the shared operating specification for the whole team. It is the same text in all twelve on purpose: the rules about ownership, lifecycle gates, evidence and financial authority are not role-specific, and an agent that reads only its own pack still gets them.

| Agent | Pack |
|---|---|
| HERMES | `team/agents/hermes/SKILL.md` |
| ARCHITECT | `team/agents/architect/SKILL.md` |
| SENTINEL | `team/agents/sentinel/SKILL.md` |
| BACKEND | `team/agents/backend/SKILL.md` |
| FRONTEND | `team/agents/frontend/SKILL.md` |
| BLOCKCHAIN | `team/agents/blockchain/SKILL.md` |
| INTELLIGENCE | `team/agents/intelligence/SKILL.md` |
| DEVOPS | `team/agents/devops/SKILL.md` |
| QA | `team/agents/qa/SKILL.md` |
| DOCS | `team/agents/docs/SKILL.md` |
| PRODUCT | `team/agents/product/SKILL.md` |
| AGENT-ENGINEER | `team/agents/agent-engineer/SKILL.md` |
