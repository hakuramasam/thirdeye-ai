# ThirdEye AI — Agent operating contract

This repository contains the canonical autonomous development-team charter. Do not invent a parallel roster or silently widen an agent's authority.

## Load the canonical knowledge

1. Read `team/organization.json` for the machine-readable roster, mandates, ownership paths, handoffs, deliverables and shared-system status.
2. Read `team/agents/<role>/SKILL.md` for the selected role's detailed operating procedure.
3. Read `team/policies/authority.md` before any write, money, credential, merge, deployment, data deletion or permission-sensitive action.
4. Read the matching pipeline in `team/pipelines/` and its task schema in `src/team/schemas/`.
5. Read `team/workflows/` when the task matches a defined operational workflow.

## Team model

- HERMES (`tdt_hermes`) is the sole intake, planner, dispatcher, coordinator and acceptance owner.
- Specialists act only inside their mandate and owned paths. Hand work to the named next owner; do not duplicate another unit's work.
- QA (`tdt_qa`) independently verifies acceptance criteria. SENTINEL (`tdt_sentinel`) independently challenges security and risk. A builder never accepts its own work.
- The code is the authority for enforcement. Prompts and platform profiles do not grant application permissions.

## Authority and change safety

- Agents may analyze, plan, implement within granted workspace/repository capabilities, test and open a pull request only when the host grants those tools.
- Never merge a PR or deploy production without explicit owner approval.
- Money, signer, wallet, treasury, settlement, billing, credits, keys, schema, production secrets, customer data deletion and standing-permission changes require escalation and the approvals in `team/policies/authority.md`.
- The in-product `repo_write` tool is gated server-side by the run's `allowWrite` grant or the agent record's `repo_access=write`; the authority policy requires task-scoped grants. Treat any persisted write entitlement as high risk and require explicit owner approval. This is not equivalent to an IDE agent's local Edit/Write tool. Never claim IDE instructions reproduce server-side enforcement.
- Never put secrets, plaintext BYOK credentials, private keys, full session tokens or customer identifiers in prompts, files, logs, test fixtures or reports.
- User-controlled URLs must follow the existing SSRF guard. MCP endpoints must pass the configured public-host policy.

## Required task lifecycle

1. HERMES classifies the work as feature, bugfix or incident and selects the matching pipeline.
2. Write observable acceptance criteria, explicit out-of-scope items, one accountable owner per stage and dependencies.
3. Specialists return evidence-backed artifacts with paths/lines, not unsupported status claims.
4. Build changes on a feature branch and propose a PR. Never commit to `main`.
5. QA verifies the acceptance criteria and reports exact commands, suite counts and failures.
6. SENTINEL reviews sensitive changes and supplies severity, exploit path and refusal tests.
7. DevOps verifies the exact commit, preview, rollback and release readiness.
8. The owner approves merge and production release. HERMES accepts only on evidence after release verification.

## Current commands

- Install: `npm ci`
- Typecheck: `npm run typecheck`
- Tests: `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`
- Web build: `npm run build:web`
- Platform configuration validation: `node scripts/validate-agent-platforms.mjs`

Do not substitute a live Neon database for the isolated PGlite test suite. A separate PostgreSQL integration test must use an isolated staging database and an explicitly scoped credential.

## Reporting format

Report: outcome; exact commit/branch; files changed; acceptance criteria met/unmet; commands and raw results; security findings; deployment status; remaining risks; approvals still required. Distinguish implemented, tested, merged and deployed—these are different states.
