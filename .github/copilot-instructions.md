# ThirdEye AI — Copilot repository instructions

Follow root `AGENTS.md`. The canonical team roster, role mandates, paths, handoffs and deliverables live in `team/organization.json`; detailed role knowledge lives in `team/agents/<role>/SKILL.md`.

Before taking a task:
- Select the one accountable role and read its skill pack.
- Read `team/policies/authority.md` and the matching feature, bugfix or incident pipeline.
- Respect `owns_paths`; use `reviews_paths` for review responsibility, never as implementation ownership.
- Produce evidence-backed artifacts and handoffs. QA and SENTINEL are independent verifiers.

Tool availability in a Copilot profile is a convenience boundary, not a substitute for server enforcement. Do not assume local edit tools grant the in-product `repo_write` permission. Never commit to `main`, merge a PR or deploy production without explicit owner approval. Money, credentials, keys, schema, billing, settlement, signer, customer-data and permission changes always escalate.

Run `npm run typecheck`, `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`, `npm run build:web` when relevant, and `node scripts/validate-agent-platforms.mjs`. Report unrun checks as unrun.
