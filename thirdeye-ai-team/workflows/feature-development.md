# Feature Development Workflow

1. HERMES opens task; PRODUCT defines problem, user stories, priority, and acceptance criteria.
2. ARCHITECT creates design, API/data/event contracts, threat considerations, and ADRs.
3. HERMES assigns implementation slices to specialist owners.
4. Owners implement in isolated branches/worktrees and report evidence.
5. SENTINEL reviews security-sensitive changes; QA runs unit, integration, regression, and acceptance tests.
6. DEVOPS verifies build, configuration, observability, and staging readiness.
7. DOCS updates docs and changelog.
8. HERMES reports completion and open risks. Production release remains human-approved.
