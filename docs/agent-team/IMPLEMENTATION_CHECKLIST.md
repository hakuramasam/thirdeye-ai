# Implementation Checklist

- [ ] Inspect current repository and publish architecture inventory.
- [ ] Validate task, message, and report schemas at runtime.
- [ ] Persist tasks, task events, approvals, and audit records durably.
- [ ] Enforce server-side RBAC/capability policy.
- [ ] Implement idempotency, deadlines, cancellation, bounded retries, and concurrency limits.
- [ ] Isolate agent memory namespaces and ACLs.
- [ ] Register HERMES and enforce routing/delegation limits.
- [ ] Provision specialists with least-privilege manifests and budgets.
- [ ] Start sandbox-only; mock external providers in tests.
- [ ] Add SENTINEL and QA independent review gates.
- [ ] Test prompt injection, SSRF, cross-user access, budget races, retries, and approval mismatch.
- [ ] Add CI, staging, observability, backups, restore tests, rollback, and incident runbooks.
- [ ] Require human sign-off before production enablement.
