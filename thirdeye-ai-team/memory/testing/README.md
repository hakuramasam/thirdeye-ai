# Namespace: testing

What is tested, how to reproduce a failure, and which gaps are known. Written by QA.

## Rules

- An agent writes only its own namespace, plus `project` when it owns a decision.
- Cross-namespace reads need a task-scoped grant recorded on the task row.
- Store outcomes and reasons, never raw transcripts or credentials.
- Superseded notes are corrected in place; history lives in git, not in duplicate files.
