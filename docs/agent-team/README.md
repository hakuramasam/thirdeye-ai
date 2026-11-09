# Thirdeye AI — Multi-Agent Development Team Blueprint

Version: 1.0.0  
Status: Implementation blueprint  
Target repository: `hakuramasam/thirdeye-ai`

## Purpose
Define a coordinated 12-agent software delivery team for developing Thirdeye AI. This package specifies responsibilities, routing, permissions, handoffs, workflow gates, schemas, and implementation sequence. It is an implementation specification, not a claim that these agents or controls are already deployed.

## Team
1. **HERMES** — chief orchestrator
2. **PRODUCT** — product manager and business analyst
3. **ARCHITECT** — system architect
4. **FRONTEND** — UI/UX and frontend engineer
5. **BACKEND** — backend and database engineer
6. **INTELLIGENCE** — AI/ML and model infrastructure engineer
7. **AGENT-ENGINEER** — autonomous agent, MCP, and skills engineer
8. **BLOCKCHAIN** — Web3, wallet, and payment engineer
9. **SENTINEL** — independent security and risk reviewer
10. **QA** — independent quality and test engineer
11. **DEVOPS** — infrastructure, CI/CD, and reliability engineer
12. **DOCS** — technical documentation engineer

## Start here
1. Read `IMPLEMENTATION_PROMPT.md`.
2. Load `AGENT_REGISTRY.json` and `orchestrator/agent.json`.
3. Provision each agent using its `agents/<id>/agent.json` and `system.md`.
4. Implement the schemas and approval gates before enabling tools with side effects.
5. Begin in sandbox mode. Progress to testnet/read-only integrations only after tests and security review.

## Non-negotiable controls
- Prompt instructions are not an authorization boundary. Enforce every permission in server-side policy.
- No production private keys, API secrets, seed phrases, or credentials in prompts, memory, logs, or task payloads.
- No agent may unilaterally deploy to production, run destructive migrations, sign/broadcast transactions, transfer funds, sweep wallets, deploy contracts, or change financial/tokenomics policy.
- Require explicit human approval for those actions and for security exceptions or acceptance of critical/high residual risk.
- SENTINEL and QA report independently; HERMES cannot suppress or rewrite their findings.
- Use least privilege, scoped credentials, immutable audit events, idempotency, bounded execution, and human-readable evidence.

## Suggested initial implementation
Start with the orchestrator, typed task/report messages, server-side policy enforcement, durable task state, audit trail, and sandbox tools. Add specialist agents incrementally. Do not start with unrestricted autonomous execution.
