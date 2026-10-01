import React, { useEffect, useState, useCallback } from 'react'
import './styles.css'
import { api, short, toast, Toasts, ChainBadge, NetworkPrompt } from './wallet'
import { Landing, Overview, Keys, Byok, Credits } from './pages1'
import { Agents, Models, Docs } from './pages2'

type Tab = 'overview' | 'keys' | 'byok' | 'credits' | 'agents' | 'models' | 'docs'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'keys', label: 'API Keys' },
  { id: 'byok', label: 'BYOK' },
  { id: 'credits', label: 'Credits' },
  { id: 'agents', label: 'Agents' },
  { id: 'models', label: 'Models' },
  { id: 'docs', label: 'Docs' },
]

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [mode, setMode] = useState<string>('')
  const [tab, setTab] = useState<Tab>('overview')
  const [refreshKey, setRefreshKey] = useState(0)
  const [balance, setBalance] = useState<number | null>(null)
  const [netPrompt, setNetPrompt] = useState(false)

  const refreshBalance = useCallback(() => {
    if (user) api('/api/credits').then((r) => setBalance(r.balance_usd_micros)).catch(() => {})
  }, [user])

  useEffect(() => {
    api('/api/me')
      .then((r) => {
        if (r.user) { setUser(r.user); setMode(r.mode || '') }
      })
      .catch(() => {})
  }, [])

  useEffect(() => { refreshBalance() }, [refreshKey, refreshBalance])

  const onChanged = () => { setRefreshKey((k) => k + 1) }

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
    setUser(null); setBalance(null)
  }

  if (!user) {
    return (
      <>
        <TopBar user={null} mode={mode} balance={null} onLogout={logout} onNeedSwitch={() => {}} />
        <Landing onSignedIn={(u, m) => { setUser(u); setMode(m); onChanged() }} />
        <Toasts />
      </>
    )
  }

  return (
    <>
      <TopBar user={user} mode={mode} balance={balance} onLogout={logout} onNeedSwitch={() => setNetPrompt(true)} />
      <div className="wrap">
        {mode === 'pglite' && (
          <div className="demo-banner">
            Demo mode — data resets on restart. Connect a Postgres <code>DATABASE_URL</code> for production persistence.
          </div>
        )}
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'overview' && <Overview user={user} refreshKey={refreshKey} />}
        {tab === 'keys' && <Keys onChanged={onChanged} />}
        {tab === 'byok' && <Byok onChanged={onChanged} />}
        {tab === 'credits' && <Credits onChanged={onChanged} />}
        {tab === 'agents' && <Agents />}
        {tab === 'models' && <Models />}
        {tab === 'docs' && <Docs />}
      </div>
      {netPrompt && <NetworkPrompt onDismiss={() => setNetPrompt(false)} />}
      <Toasts />
    </>
  )
}

function TopBar({ user, mode, balance, onLogout, onNeedSwitch }: { user: User | null; mode: string; balance: number | null; onLogout: () => void; onNeedSwitch: () => void }) {
  return (
    <div className="topbar">
      <div className="brand"><span className="eye" /> Thirdeye AI</div>
      {user && <span className={'badge' + (mode === 'postgres' ? ' live' : '')}>{mode === 'postgres' ? 'LIVE' : 'DEMO'}</span>}
      <span className="spacer" />
      {user && <ChainBadge onNeedSwitch={onNeedSwitch} />}
      {user && balance !== null && (
        <span className="chip">
          <span className="muted small">Balance</span>
          <strong>${(balance / 1e6).toFixed(2)}</strong>
        </span>
      )}
      {user ? (
        <>
          <span className="chip mono" title={user.wallet}>{short(user.wallet)}</span>
          <button className="ghost small-btn" onClick={onLogout}>Disconnect</button>
        </>
      ) : null}
    </div>
  )
}

type User = { id: string; wallet: string; role: string }

export default function main() {
  const el = document.getElementById('root')
  if (!el) return
  import('react-dom/client').then(({ createRoot }) => {
    createRoot(el).render(<App />)
  })
}
main()
