## Purpose
<!-- What user-visible or operational outcome does this PR deliver? -->

## Pipeline and ownership
- Pipeline: feature / bugfix / incident / other
- Accountable owner:
- Reviewer(s):
- Related task or issue:

## Acceptance criteria
- [ ] Each criterion is observable and has evidence below.
- [ ] Out-of-scope work is stated.

## Evidence and verification
- Exact branch and head SHA:
- [ ] `npm run typecheck`
- [ ] `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`
- [ ] `npm run build:web` (when web assets or UI change)
- [ ] `npm run agent:platforms:check`
- Other checks and results:
- Checks not run (explain why):

## Security and authority
- [ ] No secrets, plaintext BYOK values, private keys, full session tokens or customer identifiers added.
- [ ] Money, signer, billing, settlement, key, schema, production-secret and customer-data boundaries reviewed.
- [ ] QA independently verified the acceptance criteria.
- [ ] SENTINEL reviewed security-sensitive changes.
- Approval required:

## Release readiness
- Preview URL and deployment ID:
- Rollback procedure:
- Production release approval: pending / approved / not applicable

> Opening this PR is not approval to merge or deploy. The owner must explicitly authorize those actions.
