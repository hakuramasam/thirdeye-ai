# Namespace: project

Product intent, scope, decisions and milestones. Readable by every agent; written by PRODUCT and HERMES.

## Rules

- An agent writes only its own namespace, plus `project` when it owns a decision.
- Cross-namespace reads need a task-scoped grant recorded on the task row.
- Store outcomes and reasons, never raw transcripts or credentials.
- Superseded notes are corrected in place; history lives in git, not in duplicate files.
