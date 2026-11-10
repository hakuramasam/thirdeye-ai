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
