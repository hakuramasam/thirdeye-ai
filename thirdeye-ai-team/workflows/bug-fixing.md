# Bug Fix Workflow

1. Capture reproduction steps, expected/actual behavior, environment, logs, and severity.
2. QA or owner creates a minimal reproducible test.
3. Consult ARCHITECT if root cause crosses boundaries.
4. Owner fixes root cause and adds regression coverage.
5. SENTINEL reviews auth, permissions, secrets, payments, wallet, network, or data isolation fixes.
6. QA verifies regression and adjacent failure cases.
7. DOCS updates troubleshooting notes if operator behavior changes.
8. HERMES closes only with evidence and known limitations.
