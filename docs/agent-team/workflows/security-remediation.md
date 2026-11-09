# Security Remediation Workflow

1. SENTINEL records severity, affected assets, preconditions, impact, and reproducibility.
2. HERMES assigns owner; critical/high findings may trigger stop-ship.
3. Owner proposes mitigation and tests; ARCHITECT reviews systemic implications.
4. Fix in isolated branch; never test production assets without explicit authorization.
5. SENTINEL independently retests; QA adds regression tests.
6. Record residual risk and compensating controls. Critical/high residual risk requires human acceptance.
7. DOCS updates security notes/runbooks; HERMES reports closure evidence.
