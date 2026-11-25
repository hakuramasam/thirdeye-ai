# Agent pipelines, mapped from CI/CD

Sam pointed me at GitLab's CI/CD primer. What is worth taking is not the YAML, it is the
pipeline model: named stages, artifacts handed forward, environments, and the distinction
between *delivery* (a human presses release) and *deployment* (the machine does). Our agents
already do the work; what they lacked was a declared shape for it, so HERMES improvised each
time and nobody could say what "done" meant for a given class of task.

The pipelines live in `team/pipelines/*.pipeline.json` and are validated by
`tests/pipelines.test.ts`, which refuses an unowned stage, an ungated stage, a consumed
artifact that was never produced, a patch released without verification, and any route to
production that is not owner-approved.

## The mapping

| GitLab concept | Ours | State |
| --- | --- | --- |
| Pipeline | `team/pipelines/<id>.pipeline.json` | new |
| Stage | A stage with an owning agent and a gate | new |
| Job runner | The agent runner (`runAgent`) | exists, no stage awareness |
| Artifacts passed between jobs | `produces` / `consumes` pairs | declared, not enforced at runtime |
| `needs:` / DAG | `consumes` ordering, checked by test | declared |
| `rules:` / `only:` | Pipeline `trigger`, plus HERMES intake | partial |
| Environments | `none`, `preview`, `production` per stage | declared |
| Manual gate before production | `approval: owner` | declared and tested |
| Protected branch | `repo_write` cannot touch main | enforced in code |
| Merge request review | `security_review` stage | exists as a role |
| CI checks on the MR | `.github/workflows/ci.yml` | **blocked: token has no workflow scope** |
| Retries and timeouts | Run-level only (`maxDuration`, budget) | partial |
| Artifact retention | `agent_runs` output, truncated | weak |

## What this changes in practice

HERMES stops inventing an order. A bug report now follows intake, diagnose, patch, verify,
security review, release, record, and he can decline at any gate. A failure names a move
(`stop`, `back_to_patch`, `escalate_owner`) rather than trailing off.

Two gates carry most of the value. `verify` must attach typecheck and suite counts, and an
unrun check is reported as unrun instead of as a pass, which is the failure mode that got us
before. `release` is the only stage that touches production and it is the only one that
requires Sam rather than HERMES, which makes continuous *delivery* our model and continuous
*deployment* deliberately out of reach until there is a real CI check to trust.

## What is still missing, honestly

The pipelines are declared but not yet enforced by the runner, so nothing stops a run from
skiping a stage today; enforcement is the next piece of work. Artifacts are passed as text in
the delegation report rather than stored and addressable, so a long pipeline loses fidelity at
each hop. And the check that would make `verify` trustworthy still cannot be installed because
of the GitHub token's missing workflow scope. Until that lands, `verify` rests on a human
reading a diff, which is exactly what a gate is supposed to replace.


## Relationship to the operating specification

`team/operating-spec/MASTER-OPERATING-SPEC.md` (adopted 2026-11-15, version 1.0) is the team's shared operating specification: roles, job categories, priorities, the fifteen-stage task lifecycle, the task envelope, delegation rules, artifact handoffs, the nine-stage financial lifecycle, failure recovery and the completion rule.

It extends the pipelines rather than replacing them. The division is deliberate:

| Concern | Authority |
|---|---|
| Who approves production | `team/policies/authority.md` (owner), unchanged |
| Stage order, gate text, failure move | the pipeline files in `team/pipelines/` |
| Requirement that a stage has an owner, a gate and an artifact | the operating specification |
| Machine-checkable form of the above | `src/team/spec.json` |
| Enforcement | `tests/operating-spec.test.ts` |

`src/team/spec.ts` exposes the specification as code: `checkTransition` orders the lifecycle and reports which gates a move skipped, `validateOperatingTask` runs the existing JSON Schema validator unchanged and then applies its own required and recommended field lists on top, so the fields it insists on are its lists rather than schema additions, `stageForTaskStatus` projects the eight stored statuses onto the chain, and `checkRoleCoverage` compares the specified roles against `team/agents/*` so an added or renamed pack cannot drift away from the document.

Two mappings worth stating explicitly, because they are judgement calls rather than facts:

- The specification names a **wallet and finance specialist** and a **data intelligence specialist**. Both map onto identities that already exist (`tdt_blockchain`, `tdt_intelligence`) instead of creating competing agents. `tdt_agent-engineer` is kept and listed as unmapped, because it owns the runner and tooling, which no specified role covers.
- The specification names four additional workflows (wallet_operation, financial_reconciliation, research, maintenance) that do not exist as pipeline files yet. `src/team/spec.json` records where each category routes today and marks those four as planned rather than built.

Known gap recorded by the suite rather than tolerated: the incident pipeline declares `incident_timeline`, `containment` and `postmortem` as produced artifacts, and none of the three is a kind the artifact registry accepts, so a handoff from those three stages is stored under the `report` fallback rather than lost, which also means its declared kind is not preserved at runtime. Fixing it means either widening `ARTIFACT_KINDS` or renaming those stage outputs; `SPEC.pipelines.known_gaps` must be updated with the fix or the suite fails.

The task schema (`src/team/schemas/task.schema.json`) was widened additively with the envelope fields the specification requires: `correlation_id`, `requester`, `source_reference`, `category`, `affected_capability`, `supporting_agents`, `out_of_scope`, `permission_scopes`, `budget_limit`. All are optional, so a task that validated before still validates.
