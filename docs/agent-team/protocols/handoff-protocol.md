# Agent Handoff Protocol

Create tasks with unique ID, accountable owner, scope, dependencies, risk, deadline, and measurable acceptance criteria. Validate task/message/report schemas and authorize every action server-side. Receiving agents acknowledge and surface missing inputs before work.

A handoff includes summary, changed paths, decisions, evidence, tests, risks, blockers, and next owner. Mark complete only when acceptance criteria have evidence. QA reviews code changes; SENTINEL reviews security/financial/network/wallet changes. Retry only idempotent work with bounded backoff and stable idempotency keys. Cancellation propagates to child tasks and tools; persist partial side effects.

Defaults: delegation depth 3, parallel agents 5. Reject cycles, self-delegation loops, unknown agents, unauthorized routes, and exceeded budgets. Persist task state and audit events durably.