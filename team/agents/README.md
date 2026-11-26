# Thirdeye agent capability packs

One file per agent, readable at runtime through `repo_read` at `team/agents/<role>/SKILL.md`.

Adding a role means adding a folder here and pointing its `system_prompt` at it, so the knowledge travels with the repository rather than living only in a database row.

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

## Platform adapters

The role packs in this directory are the single source of role-specific knowledge. Codex, Claude Code, Cursor, GitHub Copilot and Gemini CLI adapters reference these packs rather than maintaining separate copies.

- Platform map and per-role host tool scopes: `team/platforms.json`
- Runtime tool contracts: `team/tools.json`
- Knowledge, skill, workflow and schema index: `team/resources.json`
- Cross-platform setup and limitations: `docs/agent-platforms.md`
- Drift validation: `npm run agent:platforms:check`

Host tool profiles are not application authorization. The in-product runner and `team/policies/authority.md` remain authoritative.
