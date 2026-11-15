# How the team is organised

`team/organization.json` is the machine-readable chart. `tests/organization.test.ts` checks the parts that can
be checked structurally: that the chart covers the live roster, that each unit has a mandate and deliverables,
that every claimed path and skill pack exists on disk, that no two units own the same path, that pipeline owners
are known, and that the builder is not the verifier, reviewer or acceptor. It does not read the content of a
skill pack or a prompt, so it proves the packs exist, not that they say the right thing.

## One head, one mandate per unit

HERMES is the only unit that takes work in, plans it, assigns it and accepts it. Every other unit reports to
HERMES, owns one kind of work, and names who receives its output next. A unit that is asked to do work
outside its mandate hands it back rather than attempting it, which is the difference between a team and
several agents each trying the same task.

| Unit | Mandate | Hands to |
| --- | --- | --- |
| `tdt_hermes` | intake, planning, assignment, coordination, final acceptance | product, architect |
| `tdt_product` | requirements, scope, priorities, acceptance criteria | architect |
| `tdt_architect` | architecture, APIs, dependencies, integration decisions | backend, frontend, blockchain |
| `tdt_backend` | backend, database, APIs, agents, workflows | qa, sentinel |
| `tdt_frontend` | dashboard, UI, user experience, API integration | qa |
| `tdt_blockchain` | wallets, payments, treasury, ledger, reconciliation | sentinel, qa |
| `tdt_intelligence` | providers, ingestion, research, normalization, analytics | architect |
| `tdt_agent-engineer` | agent runtime, tool contracts, scheduling, execution accounting | qa, devops |
| `tdt_qa` | reproduction, testing, regression, evidence | sentinel |
| `tdt_sentinel` | threat analysis, access controls, security reviews | hermes |
| `tdt_devops` | CI/CD, infrastructure, monitoring, recovery | hermes |
| `tdt_docs` | guides, API docs, changelog, reports | hermes |

Frontend, Wallet & Finance and Data Intelligence were listed as new roles in the recommended chart. All
three already exist in the live roster: Wallet & Finance is `tdt_blockchain`, Data Intelligence is
`tdt_intelligence`, and Frontend is `tdt_frontend`. `tdt_agent-engineer` is not on that chart and is kept as
the runtime owner so no work is unowned.

## Independent verification

The unit that builds never accepts its own work. What the test asserts, exactly: in every pipeline file the
`pull_request` producer differs from the `test_report` producer, from the `review` producer and from the
`closure` producer, and QA and SENTINEL are marked `independent_verification`. That is a structural check. It
does not read prompts, and it cannot prove what the agents actually do inside a stage.

## Policy is code, not an agent's decision

Transaction authorization, identity and permissions, budget enforcement, audit integrity and production
release are enforcement services with a file each (`src/agents/payments-policy.ts`, `src/lib/keys.ts`,
`src/lib/billing.ts`, `src/agents/audit-log.ts`, `src/agents/pipeline.ts`). The test refuses a chart in which
any of them is delegated to an agent, because a language model must not be the thing that decides whether
money may move or whether production may change.

## One implementation owner per path

`owns_paths` never overlaps: no two units own the same path or a path inside another's, and a test fails if one
appears. Where a unit is responsible for reviewing code it does not implement, that lives in `reviews_paths`
instead, so implementation and review responsibility are separate facts rather than one blurred claim.

## Shared task and artifact system, and what is still missing

A stage hands its successor an addressable artifact, not prose: `src/agents/artifacts.ts` stores content with
a sha256 and a correlation id. Tasks are validated against `src/team/schemas/task.schema.json` at the
delegation boundary by `src/team/validate.ts`.

Two gaps are stated here rather than implied away:

1. Durable task rows do not exist yet. Status lives inside the run record, so a task cannot be resumed by id
   after the run that created it ends.
2. Delegation still passes report text alongside the artifact id, so fidelity drops at each hop.

Both are recorded in `organization.json` under `shared_system` and are the next structural work, ahead of any
new agent role.
