# Namespace: engineering

Implementation notes, conventions and gotchas per area (backend, frontend, agents, chain). Written by engineering agents.

## Rules

- An agent writes only its own namespace, plus `project` when it owns a decision.
- Cross-namespace reads need a task-scoped grant recorded on the task row.
- Store outcomes and reasons, never raw transcripts or credentials.
- Superseded notes are corrected in place; history lives in git, not in duplicate files.
