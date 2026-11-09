# Task lifecycle

```
queued -> assigned -> in_progress -> review -> completed
                  \-> blocked -> in_progress (after an answer)
                  \-> failed
         cancelled (from any non-terminal state)
```

Rules enforced by the runtime, not by the prompt:

1. Only `queued` tasks may be assigned. Assignment records the owner and the agent.
2. A task may only move forward through a legal transition; anything else is refused.
3. `completed` requires a report that validates against `protocols/agent-report.schema.json`.
4. `blocked` requires a blocker reason and returns to `in_progress` only when someone answers.
5. Every transition writes an audit row: task id, from, to, actor, reason, timestamp.
6. A task holds an idempotency key, so a retry converges instead of duplicating work.
7. A run that loses its worker is reclaimed after a lease timeout, not left `in_progress` forever.
