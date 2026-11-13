import React, { useEffect, useRef, useState } from 'react'
import { api } from './wallet'

type Msg = { role: 'user' | 'assistant'; content: string; cost?: string }

type ModelRow = { id: string; pricing?: { prompt?: string; completion?: string }; owned_by?: string }

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
      const list = (r.models || r.data || []) as ModelRow[]
      setModels(list)
      if (list.length && !list.some((m) => m.id === model)) setModel(list[0].id)
    }).catch(() => {})
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
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.pricing?.prompt ? ` · $${m.pricing.prompt}/M in` : ''}
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
        <button onClick={send} disabled={!token || busy || !input.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
