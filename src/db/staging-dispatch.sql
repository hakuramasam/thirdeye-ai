-- Applied only by the authenticated Preview-only staging dispatch route.
-- Never included in the global production schema migration.
CREATE TABLE IF NOT EXISTS staging_agent_dispatches (
  id                    text PRIMARY KEY,
  target_sha            text NOT NULL,
  status                text NOT NULL, -- running | completed | failed | over_budget | changes_requested
  budget_cap_usd_micros bigint NOT NULL CHECK (budget_cap_usd_micros = 67000),
  reserved_usd_micros   bigint NOT NULL DEFAULT 0 CHECK (reserved_usd_micros >= 0),
  spent_usd_micros      bigint NOT NULL DEFAULT 0 CHECK (spent_usd_micros >= 0),
  correlation_id        text NOT NULL,
  root_run_id           text,
  result_summary        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);

CREATE TABLE IF NOT EXISTS staging_agent_budget_reservations (
  id                    text PRIMARY KEY,
  dispatch_id           text NOT NULL REFERENCES staging_agent_dispatches(id),
  reservation_id        text NOT NULL,
  amount_usd_micros     bigint NOT NULL CHECK (amount_usd_micros > 0),
  settled_usd_micros    bigint,
  status                text NOT NULL, -- reserved | settled | overrun
  created_at            timestamptz NOT NULL DEFAULT now(),
  settled_at            timestamptz,
  UNIQUE (dispatch_id, reservation_id)
);
CREATE INDEX IF NOT EXISTS idx_staging_budget_dispatch ON staging_agent_budget_reservations(dispatch_id, status);
