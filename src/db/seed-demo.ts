/** Demo data for pglite (no DATABASE_URL) mode, so the dashboard isn't empty. */
import { query, one } from './index.js'

const DEMO_WALLET = '0x0000000000000000000000000000000000000d0e'

export async function seedDemoData(): Promise<void> {
  const count = await one('SELECT COUNT(*)::int AS n FROM users')
  if ((count?.n ?? 0) > 0) return
  console.log('[haku] demo mode: seeding demo data')

  await query('INSERT INTO users (id, wallet) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['demo-user', DEMO_WALLET])

  // Spread some usage + a deposit over the last 7 days
  for (let d = 6; d >= 0; d--) {
    const reqs = 8 + Math.round(Math.random() * 20)
    for (let i = 0; i < reqs; i++) {
      const pt = 200 + Math.round(Math.random() * 2000)
      const ct = 40 + Math.round(Math.random() * 500)
      const cost = Math.round((pt * 150000 + ct * 600000) / 1e6)
      await query(
        `INSERT INTO usage_events (user_id, api_key_id, model, provider, byok, prompt_tokens, completion_tokens, cost_usd_micros, status, latency_ms, created_at)
         VALUES ($1, 'demo-key', 'gpt-4o-mini', 'openai', false, $2, $3, $4, '200', $5, now() - ($6 || ' days')::interval + ($7 || ' minutes')::interval)`,
        ['demo-user', pt, ct, cost, 300 + Math.round(Math.random() * 1500), d, Math.round(Math.random() * 1440)]
      )
    }
    const spend = 50000 + Math.round(Math.random() * 200000)
    await query(
      `INSERT INTO ledger (user_id, amount_usd_micros, kind, ref, created_at)
       VALUES ($1, $2, 'usage', 'demo', now() - ($3 || ' days')::interval)`,
      ['demo-user', -spend, d]
    )
    if (d === 5 || d === 2) {
      const dep = 10000000 + Math.round(Math.random() * 20000000)
      await query(
        `INSERT INTO ledger (user_id, amount_usd_micros, kind, ref, created_at)
         VALUES ($1, $2, 'deposit', 'demo', now() - ($3 || ' days')::interval)`,
        ['demo-user', dep, d]
      )
    }
  }
  // Demo agent
  await query(
    `INSERT INTO agents (id, user_id, name, system_prompt, model, mcp_servers, x402_enabled, budget_usd_micros)
     VALUES ('demo-agent', 'demo-user', 'Market Watcher', 'You are a concise markets research agent. Summarize the day''s key moves.', 'haku-mock', '[]'::jsonb, false, 100000)
     ON CONFLICT (id) DO NOTHING`
  )
}
