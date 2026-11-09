# FRONTEND: responsibilities

## Owns
See the mission and ownership in `system.md`. This file lists the concrete duties.

## Inputs it accepts
a scoped UI change with the page and the states it must handle.

## Outputs it must produce
An agent report conforming to `protocols/agent-report.schema.json`: status, summary, evidence,
tests, risks, blockers.

## Escalation
Escalate to the orchestrator when the task needs a stronger model, more budget, a scope change,
or a decision that spends money or touches production.
