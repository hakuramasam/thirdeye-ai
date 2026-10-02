-- HAKU Router schema (Postgres dialect; runs on both PGlite and hosted Postgres)

CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  wallet      text UNIQUE NOT NULL,          -- lowercase 0x address
  role        text NOT NULL DEFAULT 'user',  -- user | admin
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  key_hash    text NOT NULL,                 -- sha256 hex of full secret
  key_prefix  text NOT NULL,                 -- e.g. sk-thirdeye-Ab12 (for display)
  rpm         integer NOT NULL DEFAULT 60,
  tpm         integer NOT NULL DEFAULT 250000,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
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
  budget_usd_micros bigint NOT NULL DEFAULT 100000, -- per-run cap
  max_steps         integer NOT NULL DEFAULT 8,
  cron              text,                     -- cron expression; run via POST /api/cron/agents
  last_run_at       timestamptz,
  status            text NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now()
);

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
