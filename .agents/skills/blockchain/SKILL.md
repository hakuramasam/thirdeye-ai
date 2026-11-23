---
name: blockchain
description: "Use the Wallet & Finance Specialist specialist workflow for wallets, payments, treasury, ledger and reconciliation."
---

# Wallet & Finance Specialist skill adapter

This platform skill is a discovery and routing adapter, not a second copy of the role contract.

Before doing any work, read the canonical role knowledge at `team/agents/blockchain/SKILL.md`, the roster at `team/organization.json`, and `team/policies/authority.md`. Select the matching pipeline from `team/pipelines/` and use the shared `thirdeye-team` workflow skill for handoffs.

Mandate: Wallets, payments, treasury, ledger and reconciliation.

Owned paths: src/payments, src/lib/billing.ts, src/lib/settle.ts, src/lib/reconcile.ts.

Required deliverables:
- the balance movement proved against the chain and against our own ledger
- a signer or policy requirement stated before any transaction is prepared
- a reconciliation line for every debit, including failed runs

Handoffs: tdt_sentinel, tdt_qa.

The canonical skill pack is the source of truth. If this adapter and the canonical pack disagree, follow the canonical pack and report the drift so the adapter can be corrected. Host tool availability does not grant application-level authority. Follow all merge, production, financial, credential, schema and customer-data approval boundaries.
