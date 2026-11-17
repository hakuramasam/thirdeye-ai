# WO-02 payment settlement invariants

This note describes the settlement contract implemented by PR #43 and its stacked follow-up PR #60.

## Idempotency scope

A deposit is globally unique by `(chain, tx_hash, token)`. The first successful credit records:

- the owning user;
- the original account-vs-API-key destination (`to_key_id`);
- the exact payment row (`payment_id`);
- the receiving platform wallet label (`received_by`).

A replay is considered settled only when all of those values match. A different destination, payment row, or receiver is a conflict; it must not be treated as a successful credit. The current global uniqueness rule deliberately allows only one credit per chain/transaction/token. If the product later needs to credit multiple receiver transfers from one transaction, the model must be changed to include a stable transfer-log identity and migrated with explicit duplicate reconciliation.

## Atomic payment credit

The payment-review and compatibility deposit endpoints use `creditPaymentDeposit`:

1. Lock the payment row with `FOR UPDATE`.
2. Re-check payment state, status, and required confirmation depth while holding the lock.
3. Insert the idempotency/deposit row with destination and payment scope.
4. Credit either the account ledger or the exact active API key.
5. Update payment state and payment-intent state.
6. Append the `credited` payment event.

All six steps run in one database transaction. If the reorg transition obtains the payment lock first, the credit is refused. If the credit transaction obtains it first, a later reorg transition observes `credited` and escalates to reconciliation. A failed payment-event insert rolls the balance write back.

## Missing receipt and reorg evidence

A single RPC response returning a null transaction receipt is `receipt_unavailable`, not proof of a reorg. The request is retryable and does not mutate payment state. A `reorg_confirmed` result is reserved for independently verified canonical-chain evidence; the current RPC adapter does not emit it yet. Automatic reorg marking therefore remains intentionally disabled until that evidence path exists.

No ledger reversal is performed automatically. A credited-then-reorged payment must be flagged for human reconciliation under the existing financial authorization boundary.

## Database audit history

`payment_events` rejects UPDATE and DELETE at the database trigger layer. New evidence is appended as another event.

## Release acceptance

- Run the PGlite suite and retain the exact CI run/commit evidence.
- Run the concurrency suite against real PostgreSQL; PGlite serializes its operations and cannot prove row-lock behavior under contention.
- Apply the `deposits` additive columns through the versioned migration process before production rollout.
- Reconcile legacy deposit rows with NULL `payment_id` / `received_by` / `to_key_id`; these rows intentionally fail closed rather than being silently adopted by a new payment claim.
- Confirm the intended product policy for multiple platform receiver transfers in one transaction.
- Obtain an independent human financial review before merge or any production use.

This automation does not merge, deploy, move funds, reverse ledger entries, or grant HERMES authority.
