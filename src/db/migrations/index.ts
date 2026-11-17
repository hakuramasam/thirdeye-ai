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
]
