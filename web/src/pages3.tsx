import React, { useEffect, useRef, useState } from 'react'
import { api } from './wallet'
import { modelLabel, normalizeModels, type CatalogModel } from './models'

type Msg = { role: 'user' | 'assistant'; content: string; cost?: string }

/** Chat with any catalogue model directly, using a session-scoped key. */
export function Playground({ user, onChanged }: { user: any; onChanged: () => void }) {
  const [models, setModels] = useState<CatalogModel[]>([])
  // Empty until the catalogue answers: the old default named a model the list might not contain,
  // so the select showed nothing selected and the first send carried no model.
  const [model, setModel] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    api('/api/models').then((r) => {
      const list = normalizeModels(r)
      setModels(list)
      if (list.length) setModel((cur) => (list.some((m) => m.id === cur) ? cur : list[0].id))
    }).catch((e) => setErr('Could not load the model catalogue: ' + String(e?.message || e)))
    // One short-lived key for this page load; it is revoked on the next load.
    api('/api/playground/token', { method: 'POST' })
      .then((r) => { setToken(r.token); setBalance(r.balance_usd_micros ?? null) })
      .catch((e) => setErr(String(e.message || e)))
  }, [])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, busy])

  async function send() {
    const text = input.trim()
    if (!text || busy || !token) return
    if (!model) {
      setErr('Pick a model first. The catalogue has not loaded, so there is nothing to send to.')
      return
    }
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
          <label style={{ flex: '1 1 260px', minWidth: 220, margin: 0 }}>
            <span className="muted">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy || models.length === 0}
              aria-label="Model"
            >
              {models.length === 0 && <option value="">{err ? 'catalogue unavailable' : 'loading models…'}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelLabel(m)}
                </option>
              ))}
            </select>
          </label>
          {/* On its own line: side by side with a 100%-wide select, this wrapped under it on a phone
              and read as if the balance were the selected model. */}
          <div className="muted small" style={{ whiteSpace: 'nowrap' }}>
            {balance !== null ? `balance $${(balance / 1e6).toFixed(4)}` : 'balance unavailable'}
            {!token && ' · no key yet'}
            {models.length > 0 && ` · ${models.length} model${models.length === 1 ? '' : 's'}`}
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
