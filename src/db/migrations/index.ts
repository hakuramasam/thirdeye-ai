export type DbMigration = {
  version: string
  name: string
  statements: readonly string[]
}

/**
 * Ordered, immutable database migrations. New migrations must use a new monotonically
 * ordered version and must never edit an already-applied migration.
 */
export const DB_MIGRATIONS: readonly DbMigration[] = [
  {
    version: '0001_wo02_deposit_scope_and_payment_event_guard',
    name: 'Bind deposits to payment scope and enforce append-only payment events',
    statements: [
      `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS to_key_id text`,
      `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS payment_id text`,
      `ALTER TABLE deposits ADD COLUMN IF NOT EXISTS received_by text`,
      `CREATE OR REPLACE FUNCTION payment_events_append_only() RETURNS trigger AS $payment_events_fn$
BEGIN
  RAISE EXCEPTION 'payment_events is append-only (%; write a new event instead)', TG_OP;
END;
$payment_events_fn$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS payment_events_no_rewrite ON payment_events`,
      `CREATE TRIGGER payment_events_no_rewrite
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION payment_events_append_only()`,
    ],
  },
  {
    version: '0002_wo02_payment_intent_destination_binding',
    name: 'Bind payment rows to their intended API-key destination',
    statements: [
      `ALTER TABLE payments ADD COLUMN IF NOT EXISTS to_key_id text`,
      `UPDATE payments p
          SET to_key_id = i.api_key_id
         FROM payment_intents i
        WHERE p.intent_id = i.id
          AND p.to_key_id IS NULL`,
    ],
  },
  {
    version: '0003_wo02_single_payment_per_intent',
    name: 'Enforce one payment claim per payment intent',
    statements: [
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM payments
            WHERE intent_id IS NOT NULL
            GROUP BY intent_id
           HAVING COUNT(*) > 1
         ) THEN
           RAISE EXCEPTION 'WO-02 migration blocked: duplicate payment rows share a payment intent; reconcile before enforcing single-use intents';
         END IF;
       END;
       $$`,
      `CREATE UNIQUE INDEX IF NOT EXISTS payments_one_claim_per_intent
         ON payments (intent_id)
         WHERE intent_id IS NOT NULL`,
    ],
  },
]
