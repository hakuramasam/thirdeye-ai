# Release Management Workflow

1. QA verifies acceptance criteria, regression suite, and release candidate.
2. SENTINEL provides independent security disposition for sensitive changes.
3. DEVOPS verifies build provenance, dependencies, secrets/config, backups, rollback, monitoring, and staging.
4. DOCS prepares release notes and operator instructions.
5. HERMES assembles release packet with commit, test evidence, risks, and rollback plan.
6. A human explicitly approves the exact production release and target.
7. DEVOPS executes only the approved release; verify health and record deployment ID.
8. If verification fails, follow approved rollback/incident procedure.
