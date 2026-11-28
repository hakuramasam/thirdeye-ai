import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let container;
let pool;

before(async () => {
  container = await new PostgreSqlContainer("postgres:16.6-alpine")
    .withDatabase("thirdeye_test")
    .withUsername("thirdeye_test")
    .withPassword("integration-only-password")
    .start();

  pool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    max: 4,
    connectionTimeoutMillis: 10_000,
  });

  const schema = await readFile(resolve(root, "src/db/schema.sql"), "utf8");
  await pool.query(schema);
}, { timeout: 120_000 });

after(async () => {
  await pool?.end();
  await container?.stop();
}, { timeout: 30_000 });

test("real PostgreSQL accepts the production schema and seeded model catalog", async () => {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM models_catalog WHERE enabled = true"
  );
  assert.ok(result.rows[0].count >= 1, "schema migration should seed enabled models");

  const version = await pool.query("SELECT current_setting('server_version_num')::int AS version");
  assert.ok(version.rows[0].version >= 160000, "integration container must run PostgreSQL 16+");
});

test("foreign keys and unique constraints are enforced by PostgreSQL", async () => {
  const userId = "tc-user-constraints";
  await pool.query(
    "INSERT INTO users (id, wallet) VALUES ($1, $2)",
    [userId, "0xtestcontainers0000000000000000000000000001"]
  );

  await assert.rejects(
    pool.query(
      "INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4, $5)",
      ["tc-orphan-key", "missing-user", "orphan", "orphan-hash", "sk-thirdeye-orphan"]
    ),
    (error) => error.code === "23503"
  );

  await pool.query(
    "INSERT INTO deposits (id, user_id, chain, token, tx_hash, amount_usd_micros) VALUES ($1, $2, $3, $4, $5, $6)",
    ["tc-deposit-1", userId, "base", "0xtoken", "0xtxhash", 125000]
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO deposits (id, user_id, chain, token, tx_hash, amount_usd_micros) VALUES ($1, $2, $3, $4, $5, $6)",
      ["tc-deposit-2", userId, "base", "0xtoken", "0xtxhash", 125000]
    ),
    (error) => error.code === "23505"
  );
});

test("ledger and usage writes commit atomically and roll back together", async () => {
  const userId = "tc-user-atomic";
  const keyId = "tc-key-atomic";
  await pool.query("INSERT INTO users (id, wallet) VALUES ($1, $2)", [
    userId,
    "0xtestcontainers0000000000000000000000000002",
  ]);
  await pool.query(
    "INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4, $5)",
    [keyId, userId, "integration", "atomic-key-hash", "sk-thirdeye-atomic"]
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)",
      [userId, -250, "usage", "tc-rollback"]
    );
    await client.query(
      "INSERT INTO usage_events (user_id, api_key_id, model, provider, prompt_tokens, completion_tokens, cost_usd_micros, status, latency_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [userId, keyId, "thirdeye-mock", "mock", 3, 4, 250, "200", 12]
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const rolledBack = await pool.query(
    "SELECT (SELECT count(*) FROM ledger WHERE ref = $1)::int AS ledger, (SELECT count(*) FROM usage_events WHERE user_id = $2)::int AS usage",
    ["tc-rollback", userId]
  );
  assert.deepEqual(rolledBack.rows[0], { ledger: 0, usage: 0 });

  await pool.query("BEGIN");
  try {
    await pool.query(
      "INSERT INTO ledger (user_id, amount_usd_micros, kind, ref) VALUES ($1, $2, $3, $4)",
      [userId, -250, "usage", "tc-commit"]
    );
    await pool.query(
      "INSERT INTO usage_events (user_id, api_key_id, model, provider, prompt_tokens, completion_tokens, cost_usd_micros, status, latency_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [userId, keyId, "thirdeye-mock", "mock", 3, 4, 250, "200", 12]
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }

  const committed = await pool.query(
    "SELECT (SELECT count(*) FROM ledger WHERE ref = $1)::int AS ledger, (SELECT count(*) FROM usage_events WHERE user_id = $2)::int AS usage",
    ["tc-commit", userId]
  );
  assert.deepEqual(committed.rows[0], { ledger: 1, usage: 1 });
});
