# ThirdEye AI agent platform integrations

This repository supports multiple coding-agent hosts while keeping one canonical team definition.

## Supported project surfaces

| Platform | Project instructions | Agent/skill surface | What it loads |
|---|---|---|---|
| OpenAI Codex | `AGENTS.md` | `.codex/agents/*.toml` + `.agents/skills/*/SKILL.md` | Twelve role-specific subagents and twelve discoverable role skills; HERMES and independent security reviewers are read-only |
| Claude Code | `CLAUDE.md` | `.claude/agents/*.md` + `.claude/skills/*/SKILL.md` | Twelve role-specific subagents and twelve role skills with least-privilege tool lists |
| Cursor | `AGENTS.md` + `.cursor/rules/thirdeye-team.mdc` | Project rules | Team and engineering guardrails |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/*.agent.md` | Role-specific custom agents |
| Gemini CLI | `GEMINI.md` | `.agents/skills/*/SKILL.md` | Team charter and twelve discoverable role skills |

The files in `team/agents/<role>/SKILL.md` remain the source of role-specific knowledge. Platform adapters must point back to these files rather than fork their contents. `team/platforms.json` records the mapping and `scripts/validate-agent-platforms.mjs` checks it.

## Agent roles

Codex custom subagents are defined in `.codex/agents/`. They inherit the parent session's provider, MCP and approval configuration; reviewer roles are configured read-only, and HERMES has shell execution disabled. Do not interpret these profiles as application-level grants.

There are twelve canonical units: HERMES, PRODUCT, ARCHITECT, BACKEND, FRONTEND, BLOCKCHAIN, INTELLIGENCE, AGENT-ENGINEER, QA, SENTINEL, DEVOPS and DOCS. Their IDs, mandates, ownership paths, handoffs and required deliverables come from `team/organization.json`. GitHub Copilot custom profiles are provided under `.github/agents/`; Claude Code subagents are provided under `.claude/agents/`. Both reference the same canonical role skill packs.

## Tools, resources and knowledge

- **Knowledge:** role packs, architecture docs, policies and workflow playbooks.
- **Resources:** task, agent-message and agent-report JSON Schemas; pipeline definitions; addressable run artifacts.
- **Tools:** in-product `repo_read`, task-scoped `repo_write`, `delegate_to_agent`, `read_artifact`, `http_fetch`, configured MCP tools and policy-guarded x402 fetches. Confirm exact current behavior in `src/agents/`.
- **Workflows:** feature, bugfix and incident pipelines plus the website-build playbook.
- **Evidence:** QA reports, SENTINEL findings, audit events, run telemetry, CI check runs and deployment SHA/health checks.

## Tool authority is not portable

IDE and cloud coding-agent tool lists only filter the tools provided by that host. They do not create or inherit ThirdEye application permissions. In particular, a local editor's `edit` tool is not the in-product `repo_write` grant. The latter is server-enforced and branch/PR-only, with sensitive-path, file-count, byte-count and credential checks. It explicitly refuses writes to agent profiles, project instructions, CI/CD workflows, team authority/pipeline contracts and the runtime's own permission/SSRF/audit enforcement code. These control-plane changes remain owner-managed. The runner currently enables it through run-level `allowWrite` or agent-record `repo_access=write`; policy requires task-scoped grants, so persisted write entitlements need explicit owner approval. External platform profiles must never claim to reproduce those controls.

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

## GitHub Actions audit — 2026-11-23

The repository's current default-branch workflow set was inspected alongside recent Actions runs.

- Repository workflows on `main`: CI, controlled Vercel preview and Neon preview-branch lifecycle. This PR adds the agent-platform contract validator to CI.
- GitHub-managed CodeQL and Advanced Security dynamic workflows were observed completing successfully. They are platform-managed, so this change does not add duplicate CodeQL workflows.
- A recent Dependabot npm update run failed. A repository `.github/dependabot.yml` is added here to make npm and GitHub Actions update cadence explicit; the failed run itself still needs its Dependabot job logs reviewed before calling it fixed.
- Historical `dependency-health.yml` runs came from `work/wo-team-01-agent-competency-upgrade`, not current `main`. That historical file references `.nvmrc` and `npm run check:runtime`, neither of which is present in the current default-branch tree. It was not copied blindly.
- Historical `wo02-postgres-integration.yml` runs came from a feature branch and the workflow is absent from current `main`. The current standard CI uses PGlite; this platform configuration does not claim that live PostgreSQL concurrency/integration coverage is active.

## GitHub task intake and PR handoff

- `.github/ISSUE_TEMPLATE/agent-task.yml` captures pipeline, accountable owner, objective, testable acceptance criteria, out-of-scope items, dependencies, risk and approvals. Owner values match the task schema enum.
- `.github/PULL_REQUEST_TEMPLATE.md` asks for evidence, exact SHA, CI/test results, independent QA/SENTINEL review, rollback and production approval.
- `.github/dependabot.yml` schedules weekly npm and GitHub Actions version updates. Dependency update PRs still require CI, review and normal approval; Dependabot is not allowed to auto-merge or deploy.


## Role-scoped hosted platform MCP connections

The in-product runner can connect to the official hosted MCP services without embedding credentials in an agent prompt or in the `agents.mcp_servers` JSON. Supported secret references are resolved by the server and bound to fixed vendor hosts:

- AgentMail: `https://mcp.agentmail.to/mcp`, auth reference `{ "provider": "agentmail" }`, runtime secret `AGENTMAIL_API_KEY`, sent only as `x-api-key` to `mcp.agentmail.to`.
- Cloudflare: `https://mcp.cloudflare.com/mcp`, auth reference `{ "provider": "cloudflare" }`, runtime secret `CLOUDFLARE_API_TOKEN`, sent only as `Authorization: Bearer ...` to `mcp.cloudflare.com`.

Never store the secret value in Neon, a prompt, source, an issue, a task artifact or a log. The configuration stores only the provider reference. The runtime rejects a provider reference pointed at a different host, a non-HTTPS URL, or a literal credential header that conflicts with the secret reference.

Each server configuration can set `allowedTools` to an exact list of remote tool names. Only those tools are exposed to that agent; unlisted tools are not callable through the runner. Omit `allowedTools` only when the full tool catalog is explicitly intended.

Example configuration (illustrative; credentials are resolved at runtime):

```json
[
  {
    "name": "agentmail",
    "url": "https://mcp.agentmail.to/mcp",
    "auth": { "provider": "agentmail" },
    "allowedTools": [
      "list_inboxes", "search_threads", "list_threads", "get_thread",
      "list_messages", "search_messages", "get_message",
      "create_draft", "list_drafts", "get_draft", "update_draft",
      "get_attachment"
    ]
  },
  {
    "name": "cloudflare",
    "url": "https://mcp.cloudflare.com/mcp",
    "auth": { "provider": "cloudflare" },
    "allowedTools": ["search", "docs", "execute"]
  }
]
```

Recommended role mapping:

| Role | AgentMail | Cloudflare |
|---|---|---|
| HERMES | No direct mailbox tools; delegate to the responsible specialist | No direct API access; coordinate DevOps/SENTINEL |
| AGENT-ENGINEER | Read inboxes/messages and create/update drafts; no send/delete/inbox administration | None |
| PRODUCT | Read support threads and create draft responses; no send/delete | None |
| DEVOPS | None | `search`, `docs`, `execute` only with a narrowly scoped account token for approved Workers/Pages/observability work |
| SENTINEL | None | Documentation/search by default; account inspection requires a separate read-only token |
| QA | Read-only inbox/thread/message checks for test fixtures | Read-only checks through a separate read-only token |
| Other roles | No connection unless their documented task requires it | No connection unless their documented task requires it |

Security requirements:

- Prefer an AgentMail pod- or inbox-scoped key for the support mailbox. Do not expose organization-wide inbox administration, message deletion, account sign-up, or outbound-send tools to agents by default.
- Use a Cloudflare token scoped to the intended account and only the required Workers/Pages/observability permissions. Do not give an agent a global account token or DNS-write/billing permissions. Cloudflare's `execute` tool can call any endpoint allowed by the token, so the token's own permission scope is the real enforcement boundary.
- A role's `allowedTools` is an additional boundary, not a replacement for provider-side permissions.
- Support replies are drafts until a human approves sending. DNS changes, production deployments, destructive operations and secret changes remain approval-gated.
- Configure `AGENTMAIL_API_KEY` and `CLOUDFLARE_API_TOKEN` only in the backend runtime secret store after the code is deployed. Do not put values in agent records.
- The current production agent rows must be explicitly configured with these reference objects after secrets are provisioned. This PR adds safe resolution and filtering; it does not alter production agent rows or enable connections by itself.
