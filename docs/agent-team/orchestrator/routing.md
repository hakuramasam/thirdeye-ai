# HERMES Routing Rules

| Work type | Primary owner | Required collaborators/review |
|---|---|---|
| Feature definition, user journey, prioritization | PRODUCT | HERMES, QA |
| Cross-service design, API/event/data contracts | ARCHITECT | relevant engineers, SENTINEL |
| UI, accessibility, frontend integration | FRONTEND | PRODUCT, BACKEND, QA |
| API, DB, authorization, background jobs | BACKEND | ARCHITECT, SENTINEL, QA |
| LLM providers, inference, evaluations | INTELLIGENCE | BACKEND, AGENT-ENGINEER, QA |
| Agent runtime, MCP, skills, tool execution | AGENT-ENGINEER | BACKEND, SENTINEL, QA |
| Chain adapters, wallets, payments, settlement | BLOCKCHAIN | BACKEND, SENTINEL, QA |
| Security review, threat model, risk register | SENTINEL | relevant owner; independent |
| Test strategy, regression, acceptance | QA | PRODUCT, relevant owners |
| CI/CD, deployment, observability, recovery | DEVOPS | ARCHITECT, SENTINEL, QA |
| Docs, API references, runbooks | DOCS | relevant owners |
| Cross-team coordination and final report | HERMES | all required owners |

## Escalation
- Ambiguous product intent → PRODUCT.
- Conflicting architecture or interface contracts → ARCHITECT, then ADR.
- Security-sensitive or financial behavior → SENTINEL before merge.
- Failed acceptance criteria → QA returns to implementation owner.
- Production-impacting operation → human approval gate; no agent can self-approve.
- Specialist disagreement → record competing evidence and ask HERMES to convene owners; do not erase dissent.
