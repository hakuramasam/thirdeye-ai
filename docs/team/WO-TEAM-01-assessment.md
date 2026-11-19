# WO-TEAM-01 — Development Agent Knowledge & Competency Upgrade

**Status:** Implemented as a reviewable proposal; practical competency is not yet certified  
**Assessment date:** 2026-11-19  
**Scope:** Existing 12-agent ThirdEye development team  
**Source baseline:** `main` at `19f2c10068d8b1c6d66e7a80c3b44731988cca54`

## Executive assessment

The repository already has a meaningful 12-unit organization chart, one HERMES orchestrator, named deliverables and handoffs, three pipeline definitions, and five policy services enforced in code. It also has structural tests that prevent overlapping ownership and require builder/tester/reviewer/acceptor separation.

That is a good organizational foundation, not proof of agent competence. The existing organization test explicitly verifies that skill packs exist but does not inspect their content. The existing capability packs were dated 2026-11-09 and included historical platform facts and test counts. This work order upgrades role guidance and adds machine-readable competency records and validation. It does not execute the agents or certify their performance.

## Existing roster and responsibility fit

| Agent | Primary mandate | Capability focus added | Critical boundary |
|---|---|---|---|
| HERMES | Intake, planning, delegation, coordination, evidence-based closure | Workflow governance, evidence provenance, GitHub lifecycle, authority policy | Cannot self-approve, overrule specialist evidence or authorize money/production |
| PRODUCT | Requirements, scope, priority, acceptance | Product discovery, KPI design, outcome measurement | Cannot claim unmeasured product outcomes |
| ARCHITECT | Architecture, APIs, data contracts | Distributed systems, migration and threat-aware design | Design authority is not release authority |
| BACKEND | APIs, database, services | PostgreSQL concurrency, idempotency, API security | Must not self-verify |
| FRONTEND | Dashboard and client integration | Accessibility, resilient states, browser E2E | No secrets in browser bundle |
| BLOCKCHAIN | Wallets, payments, treasury, ledger | Chain finality, smart-contract invariants, accounting/reconciliation | No signing, broadcasting or funds movement |
| INTELLIGENCE | Providers, ingestion, analytics | RAG provenance, model evaluation, cost/latency accounting | Generated text is not source evidence |
| AGENT-ENGINEER | Runtime, tools, MCP, skills | Least agency, tool contracts, injection resistance, bounded execution | Skills/prompts cannot grant permissions |
| QA | Reproduction, tests, evidence | Real PostgreSQL concurrency, property/fault/E2E tests | A skipped or mocked check is not a pass |
| SENTINEL | Threat analysis and security review | Agentic security, differential review, supply-chain and smart-contract security | Cannot independently review its own authored diff |
| DEVOPS | CI/CD, infrastructure, monitoring | Workflow permissions, SHA-bound deployments, secrets, recovery | No production promotion without owner approval |
| DOCS | Guides, API docs, runbooks, changelog | Docs-as-code, contract validation, evidence traceability | Must distinguish live, planned and unverified |

## Findings

### F1 — Skill existence was tested, content quality was not
The organization test checked that each agent had a `SKILL.md` file, but did not check role-specific knowledge, competency scenarios, metadata, freshness or safe operating limits. This work order adds a separate test and validator.

### F2 — Historical platform snapshots could be mistaken for current truth
Older skill packs contain dated stack details, test counts and known-gap descriptions. All packs now explicitly mark these as historical and require fresh inspection of the current repository and exact commit before relying on them.

### F3 — Role-specific high-risk knowledge needed more depth
BLOCKCHAIN, SENTINEL, QA, AGENT-ENGINEER and DEVOPS received more explicit financial, security, concurrency, agent-tool and release competencies. Other roles received role-specific measurable outcomes and practical challenge scenarios.

### F4 — Structure is not runtime enforcement
Pipeline JSON and structural tests define expected handoffs, but do not prove every gate is enforced by the runtime. The existing documented gaps around durable task rows and report-text delegation remain open and are not represented as fixed by this work order.

### F5 — Agent approval is not independent human approval
A separate agent identity can provide a separately attributable technical review only if its operation is isolated and it did not author the changes. It cannot satisfy human financial/security acceptance or replace owner approval. HERMES remains coordinator, not an independent reviewer of its own implementation.

## Implemented deliverables in this branch

- Updated all 12 role-specific `SKILL.md` packs to v2 with Agent Skills YAML metadata, competency contracts, practical challenges, freshness rules and safety boundaries.
- Added an external skill/reference source registry with provenance and import restrictions.
- Added a machine-readable competency matrix with untested status for all 12 agents.
- Added a six-stage competency evaluation and graduation plan.
- Added an authority eligibility matrix that explicitly withholds elevated privileges.
- Added a validator script and automated tests for skill metadata, roster coverage and competency records.

## What is deliberately not done

- No external scripts, packages, plugins or skills were copied or executed.
- No third-party skill was automatically installed into the runtime.
- No agent was run against a live task; all competency statuses remain `untested`.
- No GitHub reviewer identity or permission was created or changed.
- No branch protection, ruleset, CI secret, production secret, financial control or runtime authority was changed.
- No PR was merged and no deployment was made.

## Acceptance criteria

1. All 12 roster roles have v2 skill packs with valid YAML frontmatter and role-specific capability content.
2. The skill source registry records why each source is relevant and whether content/code has been imported.
3. The competency matrix records measurable domains, challenge IDs, weights and explicit untested status.
4. The validator and tests fail on missing packs, malformed frontmatter, duplicate agents, missing challenge records or unsafe graduation claims.
5. Authority policy preserves owner control over money, merges and production.
6. External content remains advisory and untrusted; imports require license/security review.

## Next required work after this PR

1. Run `node scripts/validate-agent-skills.mjs`.
2. Run `npm run typecheck` and `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`.
3. Have QA verify tests on the exact PR head SHA.
4. Have SENTINEL review the skill/runtime trust boundaries and external-source handling.
5. Execute each agent's practical challenge in a sandbox and attach evidence before changing its status from `untested`.
6. Keep HERMES authority unchanged until existing authority graduation gates are separately satisfied.
