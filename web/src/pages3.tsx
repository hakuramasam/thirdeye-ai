import React, { useEffect, useRef, useState } from 'react'
import { api, type ModelRow } from './wallet'

type Msg = { role: 'user' | 'assistant'; content: string; cost?: string }

/** Chat with any catalogue model directly, using a session-scoped key. */
export function Playground({ user, onChanged }: { user: any; onChanged: () => void }) {
  const [models, setModels] = useState<ModelRow[]>([])
  const [model, setModel] = useState('gpt-oss-120b')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    api('/api/models').then((r) => {
      const list = (r.models || []) as ModelRow[]
      setModels(list)
      // Keep the current pick only if the catalogue actually offers it; otherwise fall back to the
      // first real id. The previous code read `m.id`, a field this endpoint never returns, so every
      // option was blank and the selected model was undefined, which sent no model at all.
      if (list.length && !list.some((m) => m.model === model)) setModel(list[0].model)
      if (!list.length) setErr('No models are available on this account yet.')
    }).catch((e) => setErr(`Could not load the model list: ${String(e.message || e)}`))
    // One short-lived key for this page load; it is revoked on the next load.
    api('/api/playground/token', { method: 'POST' })
      .then((r) => { setToken(r.token); setBalance(r.balance_usd_micros ?? null) })
      .catch((e) => setErr(String(e.message || e)))
  }, [])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, busy])

  async function send() {
    const text = input.trim()
    if (!text || busy || !token) return
    const next: Msg[] = [...msgs, { role: 'user', content: text }]
    setMsgs(next); setInput(''); setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      })
      const cost = res.headers.get('x-thirdeye-cost-usd') || undefined
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`)
      const reply = data?.choices?.[0]?.message?.content ?? '(empty reply)'
      setMsgs([...next, { role: 'assistant', content: reply, cost }])
      onChanged()
    } catch (e: any) {
      setErr(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: 1, minWidth: 220 }}>
            <span className="muted">Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy || models.length === 0}>
              {models.length === 0 && <option value="">Loading models…</option>}
              {models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.model} · {m.provider} · ${(m.price_in_1m_usd_micros / 1e6).toFixed(2)}/M in
                </option>
              ))}
            </select>
          </label>
          <div className="muted" style={{ paddingBottom: 6 }}>
            {balance !== null ? `balance $${(balance / 1e6).toFixed(4)}` : 'balance unavailable'}
            {!token && ' · no key yet'}
          </div>
        </div>
      </div>

      <div className="card" style={{ maxHeight: 420, overflowY: 'auto' }}>
        {msgs.length === 0 && (
          <p className="muted">
            Ask anything. Every reply is billed per call and the exact cost is shown under it,
            the same figure an API client would see in the x-thirdeye-cost-usd header.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ margin: '12px 0' }}>
            <div className="muted" style={{ fontSize: 12 }}>{m.role}{m.cost ? ` · $${m.cost}` : ''}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="muted">thinking…</div>}
        <div ref={endRef} />
      </div>

      {err && <div className="card" style={{ borderColor: '#a33' }}><strong>Error:</strong> {err}</div>}

      <div className="card">
        <textarea
          rows={3}
          placeholder={token ? 'Message the model…' : 'Waiting for playground key…'}
          value={input}
          disabled={!token || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        />
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <button onClick={send} disabled={!token || busy || !input.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          {/* A greyed button with no explanation is the complaint, so say what is missing. */}
          <span className="muted small">
            {!token ? 'Waiting for a playground key.' : busy ? 'In flight.' : !input.trim() ? 'Type a message to enable Send.' : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
