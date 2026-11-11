-- HAKU Router schema (Postgres dialect; runs on both PGlite and hosted Postgres)

CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  wallet      text UNIQUE NOT NULL,          -- lowercase 0x address
  role        text NOT NULL DEFAULT 'user',  -- user | admin
  pay_in_token boolean NOT NULL DEFAULT false, -- prefer platform-token settlement
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_in_token boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS api_keys (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  key_hash    text NOT NULL,                 -- sha256 hex of full secret
  key_prefix  text NOT NULL,                 -- e.g. sk-thirdeye-Ab12 (for display)
  rpm         integer NOT NULL DEFAULT 60,
  tpm         integer NOT NULL DEFAULT 250000,
  budget_usd_micros bigint,                       -- null = unlimited; monthly cap
  period_start      timestamptz,                  -- start of current monthly budget period
  period_spent_usd_micros bigint NOT NULL DEFAULT 0,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- additive migrations for existing databases
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_usd_micros bigint;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS period_spent_usd_micros bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS byok_keys (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id),
  provider       text NOT NULL,              -- openai | groq | deepseek | ... (OpenAI-based)
  key_ciphertext text NOT NULL,              -- AES-256-GCM (see src/lib/crypto.ts)
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS models_catalog (
  model                text PRIMARY KEY,      -- public name users request, e.g. "gpt-4o-mini"
  provider             text NOT NULL,         -- openai | anthropic | openai-compatible | mock
  upstream_model       text NOT NULL,         -- provider-side model id
  base_url             text,                  -- required for openai-compatible providers
  price_in_1m_usd_micros  bigint NOT NULL,    -- $ per 1M input tokens, in USD micros
  price_out_1m_usd_micros bigint NOT NULL,
  enabled              boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS usage_events (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL,
  api_key_id        text NOT NULL,
  model             text NOT NULL,
  provider          text NOT NULL,
  byok              boolean NOT NULL DEFAULT false,
  prompt_tokens     integer NOT NULL,
  completion_tokens integer NOT NULL,
  cost_usd_micros  bigint NOT NULL,          -- billed to user (after margin) or 0 for BYOK
  status            text NOT NULL,           -- 200 | 4xx | 5xx | stream
  latency_ms        integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(created_at);

CREATE TABLE IF NOT EXISTS ratelimit_counters (
  api_key_id   text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  rpm_count    integer NOT NULL DEFAULT 0,
  tpm_count    integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deposits (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id),
  chain             text NOT NULL,            -- base | robinhood
  token             text NOT NULL,           -- lowercase 0x token address
  tx_hash           text NOT NULL,
  amount_usd_micros bigint NOT NULL,
  status            text NOT NULL DEFAULT 'confirmed',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash, token)
);

CREATE TABLE IF NOT EXISTS ledger (
  id               bigserial PRIMARY KEY,
  user_id          text NOT NULL,
  amount_usd_micros bigint NOT NULL,          -- signed: + credit, - spend
  kind             text NOT NULL,             -- deposit | usage | adjust | agent
  ref              text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS agents (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id),
  name              text NOT NULL,
  system_prompt     text NOT NULL,
  model             text NOT NULL,            -- references models_catalog.model
  mcp_servers       jsonb NOT NULL DEFAULT '[]', -- [{name, url, headers?}]
  x402_enabled      boolean NOT NULL DEFAULT false,
  x402_allowed_sellers jsonb NOT NULL DEFAULT '[]', -- hostnames allowed to receive x402 payments
  x402_max_per_call_usd_micros bigint NOT NULL DEFAULT 20000, -- per-call payment cap ($0.02)
  budget_usd_micros bigint NOT NULL DEFAULT 100000, -- per-run cap
  max_steps         integer NOT NULL DEFAULT 8,
  cron              text,                     -- cron expression; run via POST /api/cron/agents
  last_run_at       timestamptz,
  status            text NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS x402_allowed_sellers jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS x402_max_per_call_usd_micros bigint NOT NULL DEFAULT 20000;

CREATE TABLE IF NOT EXISTS agent_runs (
  id                text PRIMARY KEY,
  agent_id          text NOT NULL REFERENCES agents(id),
  user_id           text NOT NULL,
  status            text NOT NULL,           -- running | success | error
  input             text NOT NULL,
  output            text,
  tool_calls        integer NOT NULL DEFAULT 0,
  spend_usd_micros  bigint NOT NULL DEFAULT 0,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      text PRIMARY KEY,
  wallet     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_age ON auth_nonces(created_at);

-- ── Agent identities ─────────────────────────────────────────────────────
-- An outside agent can hold its own identity without holding its own money. An identity belongs to
-- a user account and its keys bill that account, because billing is per user and one account must
-- never be charged for another agent's traffic. What the identity adds is name, description,
-- advertised capabilities and a public directory presence.
CREATE TABLE IF NOT EXISTS agent_identities (
  id            text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text NOT NULL,
  capabilities  jsonb NOT NULL DEFAULT '[]',
  homepage      text,
  callback_url  text,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_identities_owner ON agent_identities(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_identities_status ON agent_identities(status, created_at DESC);

-- Which key speaks for which identity. Nullable, so ordinary user keys stay ordinary.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_identity_id text;

-- ── Feedback intake ──────────────────────────────────────────────────────
-- One row per report, from a signed-in user or an anonymous visitor. Kept separate from
-- support tickets because the point is a durable, queryable signal about what to build next.
CREATE TABLE IF NOT EXISTS feedback (
  id          text PRIMARY KEY,
  user_id     text,
  kind        text NOT NULL DEFAULT 'idea',
  title       text NOT NULL,
  body        text NOT NULL,
  page        text,
  contact     text,
  severity    text NOT NULL DEFAULT 'normal',
  status      text NOT NULL DEFAULT 'new',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);

-- ── Seed model catalog ───────────────────────────────────────────────────
INSERT INTO models_catalog (model, provider, upstream_model, base_url, price_in_1m_usd_micros, price_out_1m_usd_micros)
VALUES
  ('thirdeye-mock',           'mock',              'thirdeye-mock',                NULL,                                 0,       0),
  ('gpt-4o-mini',            'openai',            'gpt-4o-mini',              NULL,                                 150000,  600000),
  ('gpt-4o',                 'openai',            'gpt-4o',                   NULL,                                 2500000, 10000000),
  ('claude-sonnet-4',        'anthropic',         'claude-sonnet-4',          NULL,                                 3000000, 15000000),
  ('claude-haiku-4',         'anthropic',         'claude-haiku-4',           NULL,                                 800000,  4000000),
  ('deepseek-v3',            'openai-compatible', 'deepseek-chat',            'https://api.deepseek.com/v1',       270000,  1100000),
  -- Groq (free tier)
  ('gpt-oss-120b',           'openai-compatible', 'openai/gpt-oss-120b',       'https://api.groq.com/openai/v1',    200000,  800000),
  ('gpt-oss-20b',            'openai-compatible', 'openai/gpt-oss-20b',        'https://api.groq.com/openai/v1',    100000,  400000),
  ('qwen3.8-27b',            'openai-compatible', 'qwen/qwen3.8-27b',          'https://api.groq.com/openai/v1',    200000,  500000),
  -- Mistral (free tier)
  ('ministral-3b',            'openai-compatible', 'ministral-3b-latest',        'https://api.mistral.ai/v1',           30000,   90000),
  ('ministral-8b',           'openai-compatible', 'ministral-8b-latest',        'https://api.mistral.ai/v1',           50000,  150000),
  ('ministral-14b',          'openai-compatible', 'ministral-14b-latest',       'https://api.mistral.ai/v1',          100000,  300000)
ON CONFLICT (model) DO UPDATE SET
  provider = EXCLUDED.provider,
  upstream_model = EXCLUDED.upstream_model,
  base_url = EXCLUDED.base_url,
  price_in_1m_usd_micros = EXCLUDED.price_in_1m_usd_micros,
  price_out_1m_usd_micros = EXCLUDED.price_out_1m_usd_micros;

DELETE FROM models_catalog WHERE model IN ('llama-3.3-70b', 'mistral-small', 'magistral-small'); -- retired upstream / not on Mistral free tier

CREATE TABLE IF NOT EXISTS telegram_members (
  chat_id   BIGINT NOT NULL,
  user_id   BIGINT NOT NULL,
  username  TEXT NOT NULL DEFAULT '',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    BIGINT NOT NULL,
  user_id    BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL DEFAULT '',
  is_bot     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS telegram_messages_chat_time ON telegram_messages (chat_id, created_at);

-- Payment intents: the memo. Created before money moves, because ERC-20
-- transfers carry no memo field of their own.
CREATE TABLE IF NOT EXISTS payment_intents (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id),
  purpose           text NOT NULL,             -- api_credits | agent_budget | pay_per_call | plan_purchase | other
  memo              text,                      -- user's own words, <=140 chars
  expected_usd_micros bigint NOT NULL,
  chain_id          integer,
  status            text NOT NULL DEFAULT 'open', -- open | paid | expired | cancelled
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intents_user_status ON payment_intents(user_id, status);

-- Verified payments: what landed, who sent it, what it was worth, and the memo
-- snapshotted at receipt so later edits cannot rewrite history.
CREATE TABLE IF NOT EXISTS payments (
  id                text PRIMARY KEY,
  intent_id         text REFERENCES payment_intents(id),
  user_id           text,
  chain_id          integer NOT NULL,
  token             text NOT NULL,
  tx_hash           text NOT NULL,
  received_by       text NOT NULL,             -- treasury_vault | agent_wallet | automation_account
  sender            text,
  raw_amount        text NOT NULL,
  decimals          integer NOT NULL,
  usd_value_micros  bigint NOT NULL DEFAULT 0,
  price_usd         numeric,
  pool              text,
  purpose           text,
  memo              text,
  status            text NOT NULL,             -- recorded | refused
  refusal_code      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, token, received_by)
);
CREATE INDEX IF NOT EXISTS idx_payments_user_time ON payments(user_id, created_at DESC);

-- Partner hub: a private, scoped workspace shared between the owner, this agent and
-- named external partners. Keys are stored hashed and shown once at issue time.
CREATE TABLE IF NOT EXISTS partner_agents (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  org               text NOT NULL,
  kind              text NOT NULL DEFAULT 'agent',      -- agent | human
  key_hash          text NOT NULL UNIQUE,               -- sha256 of the bearer token
  key_prefix        text NOT NULL,
  scopes            jsonb NOT NULL DEFAULT '["read"]',  -- read | write | admin
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  last_seen_at      timestamptz
);

CREATE TABLE IF NOT EXISTS partner_messages (
  id                text PRIMARY KEY,
  author_name       text NOT NULL,
  author_kind       text NOT NULL DEFAULT 'agent',       -- owner | agent
  body              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_requests (
  id                text PRIMARY KEY,
  title             text NOT NULL,
  detail            text,
  direction         text NOT NULL DEFAULT 'from_thirdeye', -- from_thirdeye | from_partner
  status            text NOT NULL DEFAULT 'open',          -- open | answered | done | dropped
  due_at            timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_audit (
  id                text PRIMARY KEY,
  actor             text NOT NULL,
  action            text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_audit_time ON partner_audit(created_at);

-- Per-partner threading: messages belong to a partner's thread, so one partner
-- cannot read another's conversation.
ALTER TABLE partner_messages ADD COLUMN IF NOT EXISTS thread text NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_partner_messages_thread ON partner_messages(thread, created_at);

-- Write throttling counters, per identity per window.
CREATE TABLE IF NOT EXISTS partner_write_log (
  id                text PRIMARY KEY,
  actor             text NOT NULL,
  action            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_write_log ON partner_write_log(actor, created_at);

-- x402 payments our agents made to a partner, plus the partner's verification of them.
CREATE TABLE IF NOT EXISTS agent_run_payments (
  id                text PRIMARY KEY,
  run_id            text,
  seller_host       text,
  tx_hash           text,
  chain             text,
  method            text,
  expected          jsonb NOT NULL DEFAULT '{}',
  verified_onchain  boolean NOT NULL DEFAULT false,
  confirmations     integer NOT NULL DEFAULT 0,
  replay            boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'unverified', -- verified | replay | unverified | skipped | unavailable
  response          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_run_payments_run ON agent_run_payments(run_id);
CREATE INDEX IF NOT EXISTS idx_run_payments_tx ON agent_run_payments(tx_hash);

-- Founder/partner credit allowances. A wallet listed here is not blocked by a low
-- balance. monthly_cap_usd_micros = 0 means uncapped; usage is still metered.
CREATE TABLE IF NOT EXISTS credit_allowances (
  id            text PRIMARY KEY,
  wallet        text NOT NULL,
  label         text NOT NULL,
  monthly_cap_usd_micros bigint NOT NULL DEFAULT 0,
  enabled       boolean NOT NULL DEFAULT true,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_allowance_wallet ON credit_allowances(lower(wallet));
ALTER TABLE partner_agents ADD COLUMN IF NOT EXISTS merchant_wallet text;

-- Key-scoped credit: a balance belonging to one API key, funded by an onchain payment
-- tagged to that key and spent before the account balance.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS credit_usd_micros bigint NOT NULL DEFAULT 0;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS api_key_id text;

-- Token accounting: the cache split and reconciliation keys, so a bill can be explained
-- and checked against the provider instead of guessed.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS input_cached_read integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS input_cache_write integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS reasoning_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS rate_card_version text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS price_in_cached_1m_usd_micros bigint;
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS price_in_cache_write_1m_usd_micros bigint;

-- Agent teams: an agent that may delegate work to named teammates.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_delegate boolean NOT NULL DEFAULT false;

-- Realised value from a settled swap. Until this is set, a volatile-token deposit earns no credit.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS realised_usd_micros bigint;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settlement_swap_tx text;

-- Executor audit: every claim, release and settle attempt on a pending conversion.
CREATE TABLE IF NOT EXISTS payment_conversion_audit (
  id          bigserial PRIMARY KEY,
  payment_id  text NOT NULL,
  event       text NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pca_payment ON payment_conversion_audit(payment_id, created_at);

-- Sprint 1 (2026-11-09): durable scheduled runs + read-only repo tool for team agents.

-- One row per (agent, schedule slot). Unique (agent_id, lock_key) is what makes a slot
-- single-owner; lock_expires_at plus status make it recoverable after a crash.
CREATE TABLE IF NOT EXISTS agent_schedule_lock (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL,
  lock_key text NOT NULL,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  run_id text NOT NULL,
  lock_acquired_at timestamptz NOT NULL DEFAULT now(),
  lock_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'LOCKED',
  heartbeat_ts timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT uniq_agent_schedule UNIQUE (agent_id, lock_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_schedule_expires ON agent_schedule_lock(lock_expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_schedule_status ON agent_schedule_lock(status, lock_expires_at);

-- none | read | write. Only 'read' and 'write' receive the repo_read tool today.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS repo_access text NOT NULL DEFAULT 'none';

-- Profit accounting (docs/profit-split.md). A period records what was measured, so a
-- distribution can be recomputed and audited later instead of living in a spreadsheet.
CREATE TABLE IF NOT EXISTS profit_periods (
  id                       text PRIMARY KEY,
  period_start             timestamptz NOT NULL,
  period_end               timestamptz NOT NULL,
  revenue_usd_micros       bigint NOT NULL DEFAULT 0,
  provider_cost_usd_micros bigint NOT NULL DEFAULT 0,
  gas_cost_usd_micros      bigint NOT NULL DEFAULT 0,
  infra_cost_usd_micros    bigint NOT NULL DEFAULT 0,
  profit_usd_micros        bigint NOT NULL DEFAULT 0,
  level                    integer NOT NULL DEFAULT 1,
  founder_bps              integer NOT NULL DEFAULT 200,
  notes                    text,
  status                   text NOT NULL DEFAULT 'draft', -- draft | approved | distributed | void
  created_by               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_start, period_end)
);

-- One row per recipient per period. 'planned' means computed and stored, nothing sent.
CREATE TABLE IF NOT EXISTS profit_distributions (
  id                bigserial PRIMARY KEY,
  period_id         text NOT NULL REFERENCES profit_periods(id) ON DELETE CASCADE,
  recipient_kind    text NOT NULL,                       -- founder | platform_agent | team_agent | vault
  recipient_ref     text,                                -- agent id, or a label
  wallet_address    text,
  bps               integer NOT NULL,
  amount_usd_micros bigint NOT NULL,
  swept_usd_micros  bigint NOT NULL DEFAULT 0,           -- team agents: portion swept to the founder
  status            text NOT NULL DEFAULT 'planned',     -- planned | sent | failed | skipped
  tx_hash           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profit_dist_period ON profit_distributions(period_id, recipient_kind);


-- Agent monitoring: every finding the log auditor raises, deduplicated so one bad run cannot
-- produce the same alert twice, and acknowledging it is an explicit act rather than a delete.
CREATE TABLE IF NOT EXISTS agent_alerts (
  id              text PRIMARY KEY,
  code            text NOT NULL,
  severity        text NOT NULL,
  agent_id        text,
  run_id          text,
  summary         text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '{}',
  dedupe_key      text NOT NULL UNIQUE,
  dispatch_run_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_alerts_open ON agent_alerts(severity, created_at DESC);

-- Per-tool-call history, the raw material the monitor reads.
CREATE TABLE IF NOT EXISTS agent_run_events (
  id         text PRIMARY KEY,
  run_id     text NOT NULL,
  agent_id   text NOT NULL,
  seq        integer NOT NULL,
  tool       text NOT NULL,
  ok         boolean NOT NULL DEFAULT true,
  refused    boolean NOT NULL DEFAULT false,
  args_excerpt   text,
  result_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_time ON agent_run_events(created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Phase 2, PH2-001: append-only execution audit.
--
-- agent_run_events answers "what did this one run do". This table answers "what happened to this
-- piece of work, in order, across every agent that touched it": one correlation id per root
-- execution, inherited by every delegated run, with the parent link, task, pipeline and stage.
--
-- run_id is deliberately NOT a foreign key to agent_runs. An audit row must be writable when the
-- thing being audited is exactly the case where no run row exists (a permission change, a refused
-- handoff, a scheduler decision), and losing that row would be the worst outcome.
--
-- Append-only is enforced twice: the application never issues an UPDATE or DELETE, and the trigger
-- below refuses both at the database level, so a bug or an agent cannot rewrite history.
CREATE TABLE IF NOT EXISTS agent_audit_events (
  id                    text PRIMARY KEY,
  -- Monotonic insertion order. created_at alone is not a total order: two events written in the
  -- same millisecond would reconstruct in an arbitrary sequence, which is not good enough for an
  -- append-only trail a human has to read back.
  insert_seq            bigserial NOT NULL,
  event_id              text NOT NULL UNIQUE,
  correlation_id        text NOT NULL,
  trace_id              text,
  run_id                text,
  parent_run_id         text,
  task_id               text,
  agent_id              text,
  agent_role            text,
  pipeline_id           text,
  stage_id              text,
  event_type            text NOT NULL,
  actor_type            text NOT NULL DEFAULT 'agent',        -- agent | system | owner | scheduler
  authorization_context jsonb NOT NULL DEFAULT '{}',
  tool_name             text,
  artifact_ids          jsonb NOT NULL DEFAULT '[]',
  status                text,                                  -- started | succeeded | failed | denied | skipped
  error_code            text,
  error_summary         text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON agent_audit_events(correlation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_run ON agent_audit_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_parent_run ON agent_audit_events(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_audit_task ON agent_audit_events(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_type_time ON agent_audit_events(event_type, created_at DESC);

-- Addressable artifacts (PH2-003). A handoff used to be prose inside a report, so it lost
-- fidelity at every hop; now the producer stores the document once and the handoff carries an
-- address. Content is hashed so an identical retry of the same stage stores nothing new.
CREATE TABLE IF NOT EXISTS agent_artifacts (
  id             text PRIMARY KEY,                       -- art_<20 hex>; appears in prompts and trails
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  correlation_id text NOT NULL,                          -- the chain that produced it
  run_id         text,                                   -- the run that wrote this version
  parent_run_id  text,
  task_id        text,
  pipeline_id    text,
  stage_id       text,
  kind           text NOT NULL,                          -- stage.produces, or 'report' when free-form
  title          text NOT NULL DEFAULT '',
  content        text NOT NULL,
  content_sha256 text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  bytes          integer NOT NULL DEFAULT 0,
  created_by     text,                                   -- agent name
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_correlation ON agent_artifacts(correlation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON agent_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_owner_kind ON agent_artifacts(user_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_sha_unique
  ON agent_artifacts(user_id, correlation_id, kind, COALESCE(stage_id, ''), content_sha256);

ALTER TABLE agent_audit_events ADD COLUMN IF NOT EXISTS insert_seq bigserial;

CREATE OR REPLACE FUNCTION agent_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_audit_events is append-only (%; write a new event instead)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_audit_events_no_rewrite ON agent_audit_events;
CREATE TRIGGER agent_audit_events_no_rewrite
  BEFORE UPDATE OR DELETE ON agent_audit_events
  FOR EACH ROW EXECUTE FUNCTION agent_audit_events_append_only();
-- Outbound conversion. A quote is a priced promise; only a verified payout transfer settles it.
-- amount_usd_micros is what the ledger is debited on settlement, and status never moves backwards
-- out of settled: a paid redemption is a fact, not a state.
CREATE TABLE IF NOT EXISTS redemptions (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id),
  chain_id          integer NOT NULL,
  token             text NOT NULL,                    -- lowercase 0x token address
  symbol            text,
  decimals          integer NOT NULL,
  amount_usd_micros bigint NOT NULL,
  expected_out_raw  numeric(78,0) NOT NULL,
  min_out_raw       numeric(78,0) NOT NULL,           -- floor a payout must clear
  price_usd         numeric(38,18),
  pool              text,
  status            text NOT NULL DEFAULT 'quoted',   -- quoted | settled | cancelled
  payout_tx_hash    text,
  idempotency_key   text,
  expires_at        timestamptz NOT NULL,
  settled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- A retried quote with the same key returns the first one instead of pricing twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemptions_idem
  ON redemptions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- One payout settles one redemption: the replay guard for real money.
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemptions_payout
  ON redemptions(payout_tx_hash) WHERE payout_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_redemptions_user_time ON redemptions(user_id, created_at);
