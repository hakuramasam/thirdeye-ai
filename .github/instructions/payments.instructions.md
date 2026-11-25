---
applyTo: "src/payments/**,src/lib/billing.ts,src/lib/settle.ts,src/lib/reconcile.ts,src/lib/profit.ts,src/lib/keycredit.ts,src/lib/keybudget.ts,src/lib/creditPolicy.ts,src/lib/keys.ts,src/db/schema.sql"
---

# Financial and credential boundary

Treat these paths as high-risk. Do not implement, modify, migrate, sign, broadcast, settle, refund, sweep, grant credits, rotate keys or alter production credentials as an autonomous side effect.

Before proposing any change:
- Read `team/policies/authority.md` and the BLOCKCHAIN skill.
- State chain, asset, decimals, sender, recipient, amount, finality and idempotency implications where relevant.
- Require an independent SENTINEL review and QA negative tests.
- Produce a read-only diff/report and name the exact owner approval required.
- Never place secrets, private keys, plaintext BYOK values, full tokens or customer identifiers in code, prompts, logs or fixtures.

Tool instructions are not enforcement. The server-side policies and owner approval remain authoritative.
