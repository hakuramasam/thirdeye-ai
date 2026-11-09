# Pull request

## What changed

<!-- One paragraph. The reviewer should be able to decide from this alone. -->

## Why

Task: `task_id` — link to the task and the report that justified it.

## Agent provenance

| Field | Value |
|---|---|
| Agent | <!-- e.g. BACKEND --> |
| Model tier | <!-- reasoning / balanced / economical --> |
| Run spend | <!-- micro-USD, from the run record --> |
| Reviewed by | <!-- a different agent, or the owner --> |

## Verification

- [ ] Tests added or updated, and the command that ran them is quoted below
- [ ] Worked in production where the change is user-visible, with the measured figure quoted
- [ ] No secrets, keys or wallet material in the diff
- [ ] Money paths (credit, payments, budgets) reviewed by SENTINEL when touched

## Risks

<!-- What could break, who notices, and how it gets reverted. -->
