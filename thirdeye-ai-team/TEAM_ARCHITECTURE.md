# Team architecture

## Model tiering

Agents do not share one model. Cost and consequence decide the tier.

| Tier | Model | Fallbacks | Used by | Why |
|---|---|---|---|---|
| reasoning | `gpt-oss-120b` | `qwen3-32b`, `ministral-14b` | HERMES, ARCHITECT, SENTINEL | Planning, arbitration, security judgement |
| balanced | `gpt-oss-120b` | `ministral-14b`, `ministral-8b` | BACKEND, FRONTEND, AGENT-ENGINEER, BLOCKCHAIN, INTELLIGENCE, DEVOPS | Capable coding at moderate cost |
| economical | `ministral-3b` | `ministral-8b` | PRODUCT, QA, DOCS | Repetitive work with cheap verification |

Measured on production: an orchestration turn on the reasoning tier billed ~1031 micro-USD while a
short economical-tier task billed ~2 micro-USD. The tiering is the cost model, not a preference.

Escalation is one-way and audited: the orchestrator may raise a specialist for a hard task; the
specialist may not raise itself.

## Runtime enforcement

`agent.json` is the contract the runtime loads. `system.md` is intent and cannot enforce
anything on its own. The runtime, not the prompt, decides which tools exist, what the budget is,
which memory namespace is readable, and whether a transition is legal.

## Memory

Namespaces: `project`, `architecture`, `engineering`, `security`, `testing`, `operations`,
`orchestration`. An agent reads its own namespace plus `project`; it writes only its own.
Cross-namespace reads happen through a task-scoped grant recorded on the task row.

## System of record

The repository is the **spec**. The database is the **runtime**. Sync is one-way: package files
deploy into the registry, never the reverse. If the two disagree, the database is what actually
ran and the repository is what it should have been.

## Durable execution

Serverless runtimes lose work after a response returns, which we have measured twice on this
platform. Therefore: tasks live in PostgreSQL with a lease, a status transition table and an
idempotency key. A worker that dies is reclaimed, not forgotten. No in-memory queue.
