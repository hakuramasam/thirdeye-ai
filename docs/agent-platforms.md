# ThirdEye AI agent platform integrations

This repository supports multiple coding-agent hosts while keeping one canonical team definition.

## Supported project surfaces

| Platform | Project instructions | Agent/skill surface | What it loads |
|---|---|---|---|
| OpenAI Codex | `AGENTS.md` | `.agents/skills/thirdeye-team/SKILL.md` | Canonical team charter and task workflow |
| Claude Code | `CLAUDE.md` | `.claude/agents/*.md` + `.claude/skills/thirdeye-team/SKILL.md` | Twelve role-specific subagents with least-privilege tool lists |
| Cursor | `AGENTS.md` + `.cursor/rules/thirdeye-team.mdc` | Project rules | Team and engineering guardrails |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/*.agent.md` | Role-specific custom agents |
| Gemini CLI | `GEMINI.md` | Project context | Team charter, role packs and safe tool use |

The files in `team/agents/<role>/SKILL.md` remain the source of role-specific knowledge. Platform adapters must point back to these files rather than fork their contents. `team/platforms.json` records the mapping and `scripts/validate-agent-platforms.mjs` checks it.

## Agent roles

There are twelve canonical units: HERMES, PRODUCT, ARCHITECT, BACKEND, FRONTEND, BLOCKCHAIN, INTELLIGENCE, AGENT-ENGINEER, QA, SENTINEL, DEVOPS and DOCS. Their IDs, mandates, ownership paths, handoffs and required deliverables come from `team/organization.json`. GitHub Copilot custom profiles are provided under `.github/agents/`; Claude Code subagents are provided under `.claude/agents/`. Both reference the same canonical role skill packs.

## Tools, resources and knowledge

- **Knowledge:** role packs, architecture docs, policies and workflow playbooks.
- **Resources:** task, agent-message and agent-report JSON Schemas; pipeline definitions; addressable run artifacts.
- **Tools:** in-product `repo_read`, task-scoped `repo_write`, `delegate_to_agent`, `read_artifact`, `http_fetch`, configured MCP tools and policy-guarded x402 fetches. Confirm exact current behavior in `src/agents/`.
- **Workflows:** feature, bugfix and incident pipelines plus the website-build playbook.
- **Evidence:** QA reports, SENTINEL findings, audit events, run telemetry, CI check runs and deployment SHA/health checks.

## Tool authority is not portable

IDE and cloud coding-agent tool lists only filter the tools provided by that host. They do not create or inherit ThirdEye application permissions. In particular, a local editor's `edit` tool is not the in-product `repo_write` grant. The latter is task-scoped, server-enforced, branch/PR-only and has sensitive-path, file-count, byte-count and credential checks. External platform profiles must never claim to reproduce those controls.

No repository MCP endpoint is configured by default. This is intentional: MCP server URLs, host allowlists, authentication headers and secrets must be configured and approved in the consuming platform/environment. Do not commit credentials or placeholder endpoints that appear usable.

## Human approval boundaries

No profile grants autonomous merge or production deployment. Money, signer, wallet, treasury, billing, settlement, key, schema, production-secret, customer-data deletion and standing-permission changes require the approvals in `team/policies/authority.md`.

## Setup

1. Open the repository in the target platform; its project instructions load from the documented path.
2. Choose the relevant role profile or invoke the `thirdeye-team` skill.
3. Ensure the host's MCP integrations are configured separately and minimally.
4. Run `node scripts/validate-agent-platforms.mjs` after changing the roster or any adapter.
5. Validate the exact task with typecheck/tests and independent QA/SENTINEL review as applicable.

## Known limitations

- A role prompt cannot prove the agent actually performed its task. The runtime needs execution evidence and independent checks.
- The repository's current agent runtime still documents gaps in durable task rows and artifact-only delegation in `team/organization.json`.
- This configuration does not automatically provision third-party accounts, install MCP servers, distribute secrets, enable provider-side agent teams, or alter GitHub/Vercel/Cloudflare settings.
