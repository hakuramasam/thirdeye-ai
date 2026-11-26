# Migration strategy: `ops_events` and the cron discrepancy

Written 2026-11-15 against `main` at `c3140a4`. This is a plan and an evidence record, not a claim
that anything below is applied. No migration in this document has been applied to production; read-only schema and API observations were used to write it.

Two subjects, because they are the same subject seen twice: **the platform has no way to change its
own database deliberately**, so a table that the code already writes to was never created, and a
schedule that the code already assumes was never configured. Both fail quietly.

---

## 1. How schema change works today

```
src/db/index.ts:124  export async function migrate(): Promise<void> {
src/db/index.ts:126    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
src/db/index.ts:127    if (env.databaseUrl) {
src/db/index.ts:128      await query(schema)          // one multi-statement simple-query call
src/db/index.ts:129    } else { await getPglite().exec(schema) }
```

One 625-line file, 34 `CREATE TABLE`, 25 `ALTER TABLE ... ADD COLUMN`, 97 `IF NOT EXISTS` guards,
executed as a single blob on every process boot, once per process (a module-level `migrated` flag
short-circuits later calls).

It has worked. That is worth saying plainly: idempotent additive DDL replayed on boot is a
legitimate strategy for a young schema, and it is why 34 tables exist in production with no
migration tooling at all. The question is only whether it still holds for what is coming.

### The five properties it does not have

| Property | Today | Consequence |
| --- | --- | --- |
| Atomicity | A multi-statement simple query runs as one implicit transaction, so the file applies whole or not at all | The cost is one long DDL transaction holding locks, and no recorded version: a boot cannot tell whether the schema it found is the one the file describes |
| Ordering | The file is a blob keyed by nothing | No way to say "this environment has applied up to X" |
| Versioning | No `schema_migrations` table | A fresh database and a year-old one can differ without anyone being able to tell |
| Reversibility | No down path anywhere | A wrong column type or a destructive change is a one-way door |
| Deliberateness | Runs on every cold start | Every DDL change replays on every lambda boot, including the destructive kind |

The last row is the one that bites first. `agent_audit_events` is append-only via a trigger, and the
schema creates it the only way a replayed file can: `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`.
That is a destructive statement, executed on every boot, because there is no other way to express
"change this trigger" in a file that must be safe to re-run. It is correct today. It stops being
correct only when the trigger's timing or events change. The body itself is replaceable with `CREATE OR REPLACE FUNCTION` without dropping the trigger, and both statements carry guards so a replay is harmless.

---

## 2. The motivating defect: `ops_events` was never created

```
src/inngest/functions.ts:35
  INSERT INTO ops_events (id, kind, detail) VALUES (gen_random_uuid()::text, 'conversion_blocked', $1)
  ).catch(() => {})
```

There is no `ops_events` table. The history a backfill would need is only partly missing: `payment_conversion_audit` already records claim and release attempts for blocked conversions, so the new table can be seeded from it rather than started empty. `grep -rn "ops_events"` across `src/` and `tests/`, excluding this document, and
`*.sql` returns exactly this one line and no DDL. The table exists only in the code's intent.

So, every ten minutes, when the conversion pass has blockers worth recording, the write throws
"relation does not exist" and `.catch(() => {})` discards it. The failure is invisible by
construction: no log line, no alert, no row. Whatever deposits are currently sitting blocked for
want of a signer have left no durable trace beyond the `payments` rows themselves.

That is a real defect, but the interesting part is *why it survived review*: a table can be
referenced from shipped code and never created, because nothing checks that the code's SQL targets
exist. A migration ledger with a test that boots a database, applies the migrations and then runs
one query per referenced table would have caught it.

**Two things this document deliberately does not do.** It does not create `ops_events` with an
invented schema, and it does not remove the `.catch`. Removing the swallow without the table present
turns a silent failure into a loud one every ten minutes, which is worse for an operator until the
table exists. The order is: M0 framework, M1 `ops_events`, then remove the swallow and replace it
with a surfaced error.

### What `ops_events` should be, given what already exists

There are already three event-shaped tables on `main`. Adding a fourth without deciding its
relationship to them is how a platform ends up with several sources of truth.

| Table | Line | Holds | Append-only |
| --- | --- | --- | --- |
| `usage_events` | `schema.sql:53` | billable request accounting | no trigger |
| `agent_run_events` | `schema.sql:496` | one row per tool call in a run | no trigger |
| `agent_audit_events` | `schema.sql:524` | agent-domain trail, `insert_seq` order, correlation ids | `agent_audit_events_no_rewrite` (587-596) refuses UPDATE/DELETE |

A fourth, `payment_events`, exists only on the unmerged WO-02 branch (PR #43) and is append-only by
convention there, not by a trigger. It is worth naming because it is the same shape being built a
second time, which is the drift this document is about.

The honest recommendation is **not** to build a parallel spine. `agent_audit_events` already has the
properties an event spine needs: monotonic `insert_seq`, `correlation_id`, `run_id`, `pipeline_id`,
`stage_id`, `actor_type`, JSONB metadata, and an append-only trigger. What it lacks is platform-wide
reach: it is written by the agent audit module, and its name promises less than the design can
deliver.

Two options, with the decision left to the owner:

- **Option A, rename inward.** Make `ops_events` the table, and turn `agent_audit_events` into a view. This is not a rename alone: the existing writer supplies `kind` and `detail` while `agent_audit_events` keys on `stage_id` and `actor_type`, so the view needs a column mapping
  over it filtered to agent-domain event types. One truth, one writer, existing readers keep working.
  Cost: a rename with data in it, so it is the first migration that cannot be done by replaying
  idempotent DDL.
- **Option B, keep both, add a boundary.** `agent_audit_events` stays the agent trail; `ops_events`
  carries platform events that have no agent (conversions, cron ticks, deploy markers). Cost: two
  append-only trails and a rule about which goes where, which will drift unless a test enforces it.

I recommend Option A, because the failure this document exists to fix is exactly "two places that
are supposed to agree and nothing checks that they do". Option B institutionalises that. But A
touches a table with production rows under an append-only trigger, so it needs a backfill plan and
the owner's signature, and it must not be smuggled into an unrelated change.

---

## 3. The cron discrepancy is five-way, not three

The per-agent scheduler is written for frequent invocation and deployed for daily invocation. Every
artifact that describes it disagrees.

| Where | Says | Line |
| --- | --- | --- |
| `vercel.json` | one cron, `/api/cron/agents`, `0 9 * * *` — daily, 09:00 UTC | `crons[0]` |
| `web/src/pages2.tsx` | placeholder `*/30 * * * *` on both the agent form and the edit form | `:179`, `:274` |
| `docs/ARCHITECTURE.md` | "minute-resolution check" | `:115` |
| `docs/system-architecture.md` | "hourly cron" | `:56` |
| `README.md` | two contradictory claims in one file: a daily 18:30 UTC cron, and an hourly cron fed by an external pinger | `:28`, `:84` |
| `src/agents/schedule-lock.ts` | slot key `cron:YYYY-MM-DDTHH:MM` — dedupe per wall-clock **minute** | `:31` |
| `src/routes/agents.ts` | `SCHEDULE_LOOKBACK_MINUTES = 26 * 60` — a 26-hour "did we miss a slot" window | `:267` |

Read the code and the deployment together and the defect is unambiguous: the slot key is
minute-granular and the lookback is 26 hours, which are the signatures of a pinger that fires often
and tolerates missing several ticks. The deployment fires **once a day**. So:

- an agent with `*/30 * * * *` gets one run per day under the deployed daily cron, not 48, unless the external pinger documented at `README.md:84` is wired up, and the UI never says which;
- the minute-granular slot key can never be exercised for its actual purpose, because two ticks in
  the same minute cannot happen;
- the 26-hour lookback is quietly doing the work of the schedule: it is what makes a daily tick
  acceptable at all, and it is what would make a *missed* day run late rather than vanish.

Meanwhile a second scheduler is live and has nothing to do with agents: Inngest is configured in
production (`GET /api/inngest` answers `401 Unauthorized`, i.e. the signed-request handler ran, not
the `503` "not configured" branch), and `convertPendingDeposits` carries its own `*/10 * * * *`
trigger. Two schedulers, two cadences, one of them able to reach the agent roster.

### Options

1. **Fix the deployment to match the code.** Add sub-daily invocations of `/api/cron/agents`. Vercel
   cron on this plan is limited in both count and frequency, and each invocation is a billable
   function call that can run up to the agent ceiling, so the cost is real and must be measured
   before it is enabled, not after.
2. **Fix the code to match the deployment.** Make daily the documented truth: reject or clamp any
   `cron` finer than the pinger, say so in the UI instead of showing a `*/30` placeholder, and
   correct both docs.
3. **Move agent scheduling onto Inngest**, which already runs at `*/10` and is durable with retries.
   This is the option that matches where the platform is going, and the largest of the three.

I recommend 2 immediately and 3 as the target, because 1 pays for a cadence nobody has asked for
while the 26-hour lookback already covers the failure it was meant to fix, and because doing 3
without 2 first means the docs stay wrong for however long 3 takes.

Whichever is chosen, one thing is not optional: **the platform must be able to say what schedule it
is actually running on.** Today it cannot. A `GET /api/admin/schedule` that reports the configured
pinger cadence, each agent's `cron`, its last successful run and its next expected slot would have
made this visible the first day it was wrong.

---

## 4. Proposed framework

Small, forward-only, and provable in one afternoon.

```
src/db/migrations/
  0000_baseline.sql        -- the current schema.sql, verbatim, applied to an empty database only
  0001_ops_events.sql
  ...
```

- **Ledger.** `schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at
  timestamptz NOT NULL DEFAULT now(), duration_ms int)`. `id` is the filename without extension.
- **Runner.** Read the directory, sort lexicographically, skip ids already in the ledger, apply each
  remaining file **in its own transaction**, insert its row in the same transaction, log the
  duration. A migration that throws leaves the ledger untouched and the database as it was.
- **Checksums.** A file whose checksum differs from the applied one is refused, not re-applied. This
  is what stops the current habit of editing a shipped DDL statement in place, which is invisible
  today and dangerous once an environment has applied it.
- **Baseline.** A fresh database gets `0000_baseline.sql` and no others; a production database gets
  `0000` recorded as applied without executing it, but only after the live schema has been compared against `schema.sql` and the difference is empty. Recording it blind blesses whatever drift it happens to find. That is the
  one special case, and it is explicit.
- **Forward only.** No down migrations. A mistake is corrected by the next migration. This is not
  laziness: a down path that has never been executed is a down path that does not work, and the
  append-only tables make most reversals lossy anyway.
- **No swallows.** The runner fails the boot loudly. A migration that cannot apply is a deployment
  that must not serve traffic, which is the opposite of the current `migrate()` behaviour against a
  half-applied file.

### Sequencing

| Step | Change | Reversible | Needs owner |
| --- | --- | --- | --- |
| M0 | Runner, ledger, baseline, and a test that applies every migration to an empty PGlite database | yes, code only | no |
| M1 | Add `ops_events` (or rename per Option A), then replace the `.catch(() => {})` with a surfaced failure | yes, additive | no |
| M2 | The `agent_audit_events` decision, if Option A: backfill, view, then a read-only verification window before any writer changes | no | **yes**, it touches production rows |
| M3 | Wait until M0 exists. Re-run "does every SQL table referenced in `src/` exist" as a test, so the `ops_events` class of defect cannot recur | n/a | no |

M3 is the one that pays for the whole framework, and it is cheap: parse the `INSERT INTO` / `FROM`
targets out of the source and assert each is a table or view in a freshly migrated database. The
`ops_events` defect would have failed that test on the day it was written.

---

## 5. Non-goals

- No production migration is run by this document, and no `ops_events` schema is invented here.
- No change to the cron deployment until the cadence question is decided: enabling a sub-daily
  pinger spends money on function invocations and must be measured first.
- No change to `agent_audit_events` while it holds production rows without the owner's signature.
- No partition, retention or archival policy for `ops_events` in this phase. It is worth writing
  down that an append-only table with no retention policy becomes an unbounded table, and that the
  answer is a decision about how long operational events are kept, not a default.

## 6. Open decisions for the owner

1. `ops_events`: Option A (rename inward, one truth) or Option B (two trails, explicit boundary)?
2. Cron: accept daily and correct the code and docs (recommended now), or fund a sub-daily pinger,
   or move agent scheduling to Inngest (recommended target)?
3. Retention for `ops_events` once it exists: how long is an operational event kept?
