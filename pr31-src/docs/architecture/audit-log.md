# Execution audit and correlation ids (PH2-001)

The audit log answers one question: **what happened to this piece of work, in order, across every
agent that touched it?**

`agent_run_events` already recorded tool calls per run, and the monitor reads it. What it could not
do was span a delegation chain: no correlation id, no parent run, no task or pipeline context, and
no record of an authorization decision. Every later phase depends on that, because a pipeline stage
transition and an artifact handoff are meaningless without a way to prove which execution produced
them.

## The shape of it

Three identifiers, each with one job:

| Identifier | Scope | Purpose |
| --- | --- | --- |
| `correlation_id` | one root execution and everything it delegates | reconstruct the whole chain |
| `run_id` | one execution | identify a single agent run |
| `parent_run_id` | one delegated run | point back at the run that delegated it |

A root run generates `corr_<uuid>` in `runAgent`. Every delegated child receives that same
correlation id, its own run id, `parent_run_id` set to the caller, and the task id of the handoff.
`trace_id` is derived from the run id with the existing `traceIdFrom`, so Langfuse spans and audit
rows agree without a second naming scheme.

`readAuditEvents({ correlationId })` returns the chain in insertion order (`insert_seq`, not
`created_at`, because two events written in the same millisecond need a total order).

## Event types

22 types, all declared in `AUDIT_EVENT_TYPES`:

`run.created`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`,
`task.created`, `task.delegated`, `task.accepted`, `task.completed`, `task.rejected`,
`stage.started`, `stage.completed`, `stage.skipped`,
`artifact.created`, `artifact.updated`, `artifact.read`,
`tool.invoked`, `tool.denied`, `permission.changed`,
`approval.requested`, `approval.granted`, `approval.rejected`.

An unknown type throws instead of being written. A row that cannot be interpreted later is worse
than a failed write, because it looks like evidence.

## Append-only, enforced twice

The application never issues an UPDATE or DELETE against `agent_audit_events`. The table also
refuses both, with a `BEFORE UPDATE OR DELETE` trigger that raises:

```
agent_audit_events is append-only (UPDATE; write a new event instead)
```

Both refusals are tested. A correction is a new event, not an edit.

## Fail closed where authority moves

Most audit writes are best effort. A run that cannot record a note about a tool call should still
finish, because the owner has already paid for the work and observability is not worth the run.

Authority is different. `CRITICAL_EVENT_TYPES` is `task.delegated`, `permission.changed`,
`approval.requested`, `approval.granted`, `approval.rejected`. For those, a failed insert raises
`AuditUnavailableError` and the caller must refuse. The runner does exactly that: if the handoff
cannot be recorded, the delegation is refused and the child never runs, so authority never moves
without a trace.

`tool.denied` is deliberately **not** critical. A denial has already failed closed (nothing ran), so
refusing to continue because the denial could not be recorded would punish the caller for a report
integrity problem. Denials are recorded best effort and surfaced by the monitor instead.

## What is never stored

Every string is scrubbed for credential shapes (`sk-`, `Bearer`, `AKIA`, `ghp_`, private key
blocks) and every object is redacted by key (`token`, `secret`, `api_key`, `password`,
`authorization`, `cookie`, `mnemonic`, `private_key`) to a bounded depth. Tool arguments are
recorded as a 300-character scrubbed excerpt, never in full, matching the existing monitor
discipline.

## Deployment

`agent_audit_events` is created by `src/db/schema.sql`, which `migrate()` applies at boot with
`CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. There is no separate migration runner
in this repository, so the boot path *is* the migration and it is idempotent. Adding the table is
therefore safe on an existing database, and no production DDL is run by hand.

## Tests

`tests/audit-log.test.ts` (11 cases): correlation id uniqueness, full field persistence, UPDATE and
DELETE refusal, credential scrubbing by shape and by key, fail-closed for every critical type,
best-effort for routine types, unknown type rejection, denial recording, the stage/artifact/
authorization recorders, taxonomy completeness, and restart durability proved across **two
processes** (`tests/helpers/audit-restart-probe.ts` writes, a second process reads back from the
same data directory).

`tests/audit-correlation.test.ts` (6 cases): a root run keeps one correlation id; a delegated run
inherits it with its own run id and parent link; the handoff and its outcome are both recorded;
refused tools become `tool.denied` with a reason; a crash leaves `run.failed` with a stable error
code; credentials in tool arguments never reach the table.

## Not done here

- The API exposes no endpoint to read the audit trail. The dashboard view is PH2-008.
- The monitor still reads `agent_run_events`. Wiring its detectors to structured audit events is
  the next step, after pipeline stage events exist to detect against.
- Pipeline stage transitions and artifact events have recorders, but nothing emits them yet; those
  belong to PH2-002 and PH2-003.
