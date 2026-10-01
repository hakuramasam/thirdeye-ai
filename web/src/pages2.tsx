import React, { useEffect, useState, useCallback } from 'react'
import { api, fmtUsd, fmtDate, toast } from './wallet'

type AgentRow = {
  id: string; name: string; system_prompt: string; model: string
  mcp_servers: { name: string; url: string }[]
  x402_enabled: boolean; budget_usd_micros: number; max_steps: number
  cron: string | null; last_run_at: string | null; status: string; created_at: string
}
type RunRow = { id: string; status: string; input: string; output: string | null; tool_calls: number; spend_usd_micros: number; error: string | null; created_at: string }
type ModelRow = { model: string; provider: string; price_in_1m_usd_micros: number; price_out_1m_usd_micros: number }

/* ---------------- agents ---------------- */
const emptyForm = {
  name: '', system_prompt: '', model: '', budget_usd_micros: '100000',
  max_steps: '8', cron: '', x402: false,
  mcp: [{ name: '', url: '' }],
}

function Agents() {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [models, setModels] = useState<ModelRow[]>([])
  const [form, setForm] = useState(emptyForm)
  const [busy, setBusy] = useState(false)
  const [runsFor, setRunsFor] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [runResult, setRunResult] = useState<{ output: string | null; error: string | null; tool_calls: number; spend_usd_micros: number } | null>(null)
  const [runInput, setRunInput] = useState('')
  const [runBusy, setRunBusy] = useState(false)

  const load = useCallback(() => {
    api('/api/agents').then((r) => setAgents(r.agents)).catch(() => {})
    api('/api/models').then((r) => setModels(r.models)).catch(() => {})
  }, [])
  useEffect(load, [load])

  const create = async () => {
    setBusy(true)
    try {
      const mcp = form.mcp.filter((m) => m.name && m.url)
      await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          system_prompt: form.system_prompt || 'You are a helpful assistant.',
          model: form.model,
          mcp_servers: mcp,
          budget_usd_micros: Number(form.budget_usd_micros),
          max_steps: Number(form.max_steps),
          cron: form.cron.trim() || null,
          x402_enabled: form.x402,
        }),
      })
      toast('Agent created')
      setForm(emptyForm)
      load()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }

  const del = async (id: string) => {
    try { await api('/api/agents/' + id, { method: 'DELETE' }); toast('Agent deleted'); load() } catch (e: any) { toast(e.message, 'error') }
  }

  const runNow = async (a: AgentRow) => {
    setRunsFor(a.id); setRunResult(null); setRunInput('')
    api('/api/agents/' + a.id + '/runs').then((r) => setRuns(r.runs)).catch(() => setRuns([]))
  }

  const doRun = async (a: AgentRow) => {
    setRunBusy(true)
    try {
      const r = await api('/api/agents/' + a.id + '/run', { method: 'POST', body: JSON.stringify({ input: runInput }) })
      setRunResult(r)
      if (r.status === 'success') toast('Run complete')
      else toast(r.error || 'Run failed', 'error')
      api('/api/agents/' + a.id + '/runs').then((rr) => setRuns(rr.runs)).catch(() => {})
    } catch (e: any) {
      setRunResult({ output: null, error: e.message, tool_calls: 0, spend_usd_micros: 0 })
      toast(e.message, 'error')
    } finally { setRunBusy(false) }
  }

  const setMcp = (i: number, patch: Partial<{ name: string; url: string }>) => {
    setForm((f) => ({ ...f, mcp: f.mcp.map((m, j) => (j === i ? { ...m, ...patch } : m)) }))
  }

  return (
    <div>
      <div className="card">
        <h2>Create agent</h2>
        <div className="row">
          <div><label>Name</label><input value={form.name} placeholder="market-watcher" onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div>
            <label>Model</label>
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              <option value="">Select…</option>
              {models.map((m) => <option key={m.model} value={m.model}>{m.model}</option>)}
            </select>
          </div>
        </div>
        <label>System prompt</label>
        <textarea rows={3} value={form.system_prompt} placeholder="You are an autonomous market research agent…" onChange={(e) => setForm({ ...form, system_prompt: e.target.value })} />
        <div className="row">
          <div><label>Budget per run (USD micros)</label><input value={form.budget_usd_micros} onChange={(e) => setForm({ ...form, budget_usd_micros: e.target.value })} /></div>
          <div><label>Max steps</label><input value={form.max_steps} onChange={(e) => setForm({ ...form, max_steps: e.target.value })} /></div>
          <div><label>Cron (optional, 5-field)</label><input value={form.cron} placeholder="*/30 * * * *" onChange={(e) => setForm({ ...form, cron: e.target.value })} /></div>
        </div>
        <label>MCP servers (streamable HTTP)</label>
        {form.mcp.map((m, i) => (
          <div className="row" key={i} style={{ marginBottom: 8 }}>
            <div><input value={m.name} placeholder="name" onChange={(e) => setMcp(i, { name: e.target.value })} /></div>
            <div style={{ flex: 2 }}><input value={m.url} className="mono" placeholder="https://example.com/mcp" onChange={(e) => setMcp(i, { url: e.target.value })} /></div>
            <div style={{ flex: '0 0 auto' }}>
              <button className="ghost small-btn" onClick={() => setForm((f) => ({ ...f, mcp: f.mcp.filter((_, j) => j !== i) }))}>×</button>
            </div>
          </div>
        ))}
        {form.mcp.length < 5 && (
          <button className="ghost small-btn" style={{ marginBottom: 12 }} onClick={() => setForm((f) => ({ ...f, mcp: [...f.mcp, { name: '', url: '' }] }))}>+ Add MCP server</button>
        )}
        <div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input style={{ width: 'auto' }} type="checkbox" checked={form.x402} onChange={(e) => setForm({ ...form, x402: e.target.checked })} />
            Enable x402 pay-per-call (agent gets the http_fetch tool and pays 402-gated APIs in USDC)
          </label>
        </div>
        <div style={{ marginTop: 14 }}>
          <button onClick={create} disabled={busy || !form.name || !form.model}>Create agent</button>
        </div>
      </div>

      <div className="card">
        <h2>Your agents</h2>
        {agents.length === 0 ? <p className="muted small">No agents yet.</p> : agents.map((a) => (
          <div key={a.id} style={{ borderBottom: '1px solid var(--border)', padding: '14px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <strong>{a.name}</strong>
              <span className="pill">{a.model}</span>
              {a.x402_enabled && <span className="pill on">x402</span>}
              {a.cron && <span className="pill">{a.cron}</span>}
              {a.mcp_servers.length > 0 && <span className="pill">{a.mcp_servers.length} MCP</span>}
              <span style={{ flex: 1 }} />
              <button className="ghost small-btn" onClick={() => runNow(a)}>Run now</button>
              <button className="danger-btn small-btn" onClick={() => del(a.id)}>Delete</button>
            </div>
            {runsFor === a.id && (
              <div style={{ marginTop: 12 }}>
                <div className="row">
                  <div style={{ flex: 2 }}><label>Input</label><input value={runInput} placeholder="What should the agent do?" onChange={(e) => setRunInput(e.target.value)} /></div>
                  <div style={{ flex: '0 0 auto', alignSelf: 'end' }}><button disabled={runBusy || !runInput} onClick={() => doRun(a)}>{runBusy ? 'Running…' : 'Run'}</button></div>
                </div>
                {runResult && (
                  <div className="run-box">
                    {runResult.output && <div>{runResult.output}</div>}
                    {runResult.error && <div className="danger">{runResult.error}</div>}
                    <div className="muted small" style={{ marginTop: 8 }}>
                      tool calls: {runResult.tool_calls} · spend: {fmtUsd(runResult.spend_usd_micros)}
                    </div>
                  </div>
                )}
                {runs.length > 0 && (
                  <table style={{ marginTop: 12 }}>
                    <thead><tr><th>When</th><th>Status</th><th>Input</th><th>Tools</th><th style={{ textAlign: 'right' }}>Spend</th></tr></thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id}>
                          <td className="muted">{fmtDate(r.created_at)}</td>
                          <td><span className={'pill ' + (r.status === 'success' ? 'on' : 'err')}>{r.status}</span></td>
                          <td className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.input}</td>
                          <td>{r.tool_calls}</td>
                          <td style={{ textAlign: 'right' }}>{fmtUsd(r.spend_usd_micros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------- models ---------------- */
function Models() {
  const [models, setModels] = useState<ModelRow[]>([])
  useEffect(() => { api('/api/models').then((r) => setModels(r.models)).catch(() => {}) }, [])
  return (
    <div className="card">
      <h2>Model catalog</h2>
      <p className="muted small">Brokered calls are charged catalog price + platform margin. BYOK calls are metered at 2%.</p>
      <table>
        <thead><tr><th>Model</th><th>Provider</th><th>Input price</th><th>Output price</th></tr></thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model}>
              <td className="mono">{m.model}</td>
              <td><span className="pill">{m.provider}</span></td>
              <td>{'$' + (m.price_in_1m_usd_micros / 1e6).toFixed(4)}/1M</td>
              <td>{'$' + (m.price_out_1m_usd_micros / 1e6).toFixed(4)}/1M</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- docs ---------------- */
function Docs() {
  return (
    <div>
      <div className="card">
        <h2>Quickstart</h2>
        <p className="muted small">Create an API key in the API Keys tab, then point any OpenAI SDK at the gateway.</p>
        <pre>{`import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://<your-deployment>/api/v1',
  apiKey: 'sk-thirdeye-…',
})

const res = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
})
console.log(res.choices[0].message.content)`}</pre>
        <p className="muted small">Streaming works out of the box: pass <code>stream: true</code>.</p>
      </div>
      <div className="card">
        <h2>Plain curl</h2>
        <pre>{`curl https://<your-deployment>/api/v1/chat/completions \\
  -H "Authorization: Bearer sk-thirdeye-…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}</pre>
      </div>
      <div className="card">
        <h2>Notes</h2>
        <ul className="muted small" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
          <li>Rate limits are per key (RPM/TPM), set when you create the key.</li>
          <li>Brokered calls require a positive balance and are charged per token after completion.</li>
          <li>BYOK requests route through your own provider keys (see BYOK tab).</li>
          <li>Agents run LLM + MCP tool loops with per-run budgets; cron-scheduled agents fire via POST /api/cron/agents.</li>
          <li>Unknown models return 404; insufficient balance returns 402; limit breaches return 429.</li>
        </ul>
      </div>
    </div>
  )
}

export { Agents, Models, Docs }
