import React, { useEffect, useState, useCallback } from 'react'
import './styles.css'
import { api, fmtUsd, fmtMicroPerM, short, fmtDate, toast, Toasts, useWallets, signInWith, connectWalletConnect, walletConnectConfigured, readChainId, chainById, NetworkPrompt } from './wallet'
import type { User, KeyRow, ByokRow, ChainInfo } from './wallet'

type Tab = 'overview' | 'keys' | 'byok' | 'credits' | 'agents' | 'models' | 'docs'

/* ---------------- landing ---------------- */
function Landing({ onSignedIn }: { onSignedIn: (u: User, mode: string) => void }) {
  const wallets = useWallets()
  const [busy, setBusy] = useState(false)
  const [wrongNet, setWrongNet] = useState(false)
  const afterSignIn = async (provider: any, res: any) => {
    toast('Signed in as ' + short(res.user.wallet))
    onSignedIn(res.user, res.mode)
    const chainId = await readChainId(provider)
    if (!chainById(chainId)) setWrongNet(true)
  }
  const connect = async (w: { info: { name: string; icon: string | null }; provider: any }) => {
    setBusy(true)
    try {
      const res = await signInWith(w.provider)
      await afterSignIn(w.provider, res)
    } catch (e: any) {
      toast(e.message || 'Wallet sign-in failed', 'error')
    } finally { setBusy(false) }
  }
  const connectWC = async () => {
    setBusy(true)
    try {
      const provider = await connectWalletConnect()
      const res = await signInWith(provider)
      await afterSignIn(provider, res)
    } catch (e: any) {
      toast(e.message || 'WalletConnect failed', 'error')
    } finally { setBusy(false) }
  }
  return (
    <div className="wrap">
      <div className="hero">
        <h1>Thirdeye <span className="grad">AI</span></h1>
        <p>
          One OpenAI-compatible gateway to every frontier model. Bring your own keys or pay per token
          in USDC. Run autonomous agents with MCP tools and x402 pay-per-call services.
        </p>
        <div className="center" style={{ padding: 0 }}>
          <div className="connect-box">
            <div className="card" style={{ marginBottom: 0 }}>
              <h2>Connect a wallet to get started</h2>
              <p className="muted small">
                MetaMask, Rainbow, OKX, Bitget and any injected wallet are supported.
                We only ask for a signature to create your account — no approvals, no spending.
              </p>
              <div className="wallet-list">
                {wallets.length === 0 && <p className="muted small">Detecting wallets… if none appear, use WalletConnect below or open this site in your wallet's in-app browser.</p>}
                {wallets.map((w) => (
                  <button key={w.info.uuid} className="wallet-btn" disabled={busy} onClick={() => connect(w)}>
                    {w.info.icon ? <img src={w.info.icon} alt="" /> : <span className="brand"><span className="eye" /></span>}
                    {w.info.name}
                  </button>
                ))}
                {walletConnectConfigured() ? (
                  <button className="wallet-btn" disabled={busy} onClick={connectWC}>
                    <span className="brand"><span className="eye" /></span>
                    WalletConnect
                    <span className="muted small" style={{ marginLeft: 'auto' }}>Rainbow, Trust, MetaMask… any mobile wallet</span>
                  </button>
                ) : (
                  <p className="muted small">On mobile? Open this site inside your Rainbow or MetaMask app browser, or ask us to enable WalletConnect.</p>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="feature-grid">
          <div className="card feature"><h3>OpenAI-compatible API</h3><p>Point any OpenAI SDK at /api/v1/chat/completions. Streaming, tools, and a growing model catalog.</p></div>
          <div className="card feature"><h3>BYOK</h3><p>Bring your own OpenAI, Anthropic, Groq or DeepSeek keys — we route them transparently and charge metering only.</p></div>
          <div className="card feature"><h3>USDC prepaid credits</h3><p>Top up with USDC on Base or USDG on Robinhood Chain. Pay per token, deducted from your balance.</p></div>
          <div className="card feature"><h3>Autonomous agents</h3><p>Agents that call MCP servers, pay x402-gated APIs per call, and run on cron schedules with budgets.</p></div>
          <div className="card feature"><h3>Wallet-native accounts</h3><p>Sign in with Ethereum — MetaMask, Rainbow, OKX, Bitget. No passwords, no email.</p></div>
          <div className="card feature"><h3>Usage analytics</h3><p>Token usage, cost, and platform inflow/outflow feeds — the substrate for tokenized assets.</p></div>
        </div>
      </div>
      {wrongNet && <NetworkPrompt onDismiss={() => setWrongNet(false)} />}
    </div>
  )
}

/* ---------------- overview ---------------- */
function Overview({ user, refreshKey }: { user: User; refreshKey: number }) {
  const [stats, setStats] = useState<any[] | null>(null)
  const [credits, setCredits] = useState<{ balance_usd_micros: number; ledger: any[] } | null>(null)
  useEffect(() => {
    api('/api/stats/me').then(setStats).catch(() => setStats([]))
    api('/api/credits').then(setCredits).catch(() => setCredits(null))
  }, [refreshKey])
  const totReq = (stats || []).reduce((s, d) => s + d.requests, 0)
  const totTok = (stats || []).reduce((s, d) => s + d.tokens, 0)
  const totCost = (stats || []).reduce((s, d) => s + d.cost_usd_micros, 0)
  return (
    <div>
      <div className="grid cols-3">
        <div className="stat"><div className="label">Balance</div><div className="value">{credits ? fmtUsd(credits.balance_usd_micros) : '…'}</div><div className="sub">prepaid credits</div></div>
        <div className="stat"><div className="label">Requests (14d)</div><div className="value">{totReq.toLocaleString()}</div></div>
        <div className="stat"><div className="label">Tokens (14d)</div><div className="value">{totTok.toLocaleString()}</div><div className="sub">{fmtUsd(totCost)} spent</div></div>
      </div>
      <div className="card">
        <h2>Last 14 days</h2>
        <BarChart data={stats || []} />
      </div>
      <div className="card">
        <h2>Recent ledger</h2>
        {credits?.ledger?.length ? (
          <table>
            <thead><tr><th>When</th><th>Kind</th><th>Reference</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {credits.ledger.slice(0, 12).map((l: any, i: number) => (
                <tr key={i}>
                  <td className="muted">{fmtDate(l.created_at)}</td>
                  <td><span className="pill">{l.kind}</span></td>
                  <td className="mono muted">{l.ref || '—'}</td>
                  <td style={{ textAlign: 'right' }} className={l.amount_usd_micros >= 0 ? 'ok' : ''}>{l.amount_usd_micros >= 0 ? '+' : ''}{fmtUsd(l.amount_usd_micros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted small">No ledger activity yet.</p>}
      </div>
    </div>
  )
}

function BarChart({ data }: { data: any[] }) {
  const W = 940, H = 190, PAD = 24
  const max = Math.max(1, ...data.map((d) => d.requests))
  const bw = Math.max(4, (W - PAD * 2) / data.length - 4)
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
      <line className="axis" x1={PAD} y1={H - 22} x2={W - PAD} y2={H - 22} />
      {data.map((d, i) => {
        const h = Math.round((d.requests / max) * (H - 50))
        const x = PAD + i * ((W - PAD * 2) / data.length)
        return (
          <g key={d.day}>
            <rect className="bar" x={x} y={H - 22 - h} width={bw} height={h} rx={2}>
              <title>{`${d.day}: ${d.requests} req · ${d.tokens.toLocaleString()} tokens · ${fmtUsd(d.cost_usd_micros)}`}</title>
            </rect>
            {d.deposits_usd_micros > 0 && (
              <rect className="bar deposit" x={x} y={H - 22 - h - 5} width={bw} height={4} rx={1}>
                <title>{`${d.day}: deposit ${fmtUsd(d.deposits_usd_micros)}`}</title>
              </rect>
            )}
            {i % 2 === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle">{d.day.slice(5)}</text>}
          </g>
        )
      })}
    </svg>
  )
}

/* ---------------- api keys ---------------- */
function Keys({ onChanged }: { onChanged: () => void }) {
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [name, setName] = useState('')
  const [rpm, setRpm] = useState('60')
  const [tpm, setTpm] = useState('1000000')
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { api('/api/keys').then((r) => setKeys(r.keys)).catch(() => {}) }, [])
  useEffect(load, [load])
  const create = async () => {
    setBusy(true)
    try {
      const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name, rpm: Number(rpm), tpm: Number(tpm) }) })
      setSecret(r.secret)
      setName('')
      load(); onChanged()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    try { await api('/api/keys/' + id, { method: 'DELETE' }); toast('Key revoked'); load(); onChanged() } catch (e: any) { toast(e.message, 'error') }
  }
  return (
    <div>
      <div className="card">
        <h2>Create API key</h2>
        <div className="row">
          <div><label>Name</label><input value={name} placeholder="production-app" onChange={(e) => setName(e.target.value)} /></div>
          <div><label>RPM limit</label><input value={rpm} onChange={(e) => setRpm(e.target.value)} /></div>
          <div><label>TPM limit</label><input value={tpm} onChange={(e) => setTpm(e.target.value)} /></div>
        </div>
        <div style={{ marginTop: 14 }}><button onClick={create} disabled={busy || !name}>Create key</button></div>
        {secret && (
          <div className="secret-box">
            <strong>Copy your key now — it is shown only once.</strong>
            <div className="copyable" style={{ marginTop: 10 }}>
              <span className="val">{secret}</span>
              <button className="ghost small-btn" onClick={() => { navigator.clipboard.writeText(secret); toast('Copied') }}>Copy</button>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Your keys</h2>
        {keys.length === 0 ? <p className="muted small">No keys yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th>RPM / TPM</th><th>Created</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono muted">{k.prefix}…</td>
                  <td className="muted">{k.rpm} / {k.tpm.toLocaleString()}</td>
                  <td className="muted">{fmtDate(k.created_at)}</td>
                  <td>{k.revoked_at ? <span className="pill err">revoked</span> : <span className="pill on">active</span>}</td>
                  <td>{!k.revoked_at && <button className="danger-btn small-btn" onClick={() => revoke(k.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ---------------- BYOK ---------------- */
function Byok({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<ByokRow[]>([])
  const [provider, setProvider] = useState('openai')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { api('/api/keys/byok').then((r) => setRows(r.providers)).catch(() => {}) }, [])
  useEffect(load, [load])
  const save = async () => {
    setBusy(true)
    try {
      await api('/api/keys/byok', { method: 'PUT', body: JSON.stringify({ provider, api_key: apiKey }) })
      toast('Provider key saved (encrypted)')
      setApiKey(''); load(); onChanged()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  const del = async (p: string) => {
    try { await api('/api/keys/byok/' + p, { method: 'DELETE' }); toast('Removed'); load(); onChanged() } catch (e: any) { toast(e.message, 'error') }
  }
  return (
    <div>
      <div className="card">
        <h2>Bring your own key</h2>
        <p className="muted small">Keys are encrypted at rest (AES-256-GCM) and used only to route your requests. BYOK calls are metered at 2% of catalog price.</p>
        <div className="row">
          <div>
            <label>Provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="groq">Groq</option>
              <option value="deepseek">DeepSeek</option>
            </select>
          </div>
          <div style={{ flex: 2 }}><label>API key</label><input type="password" value={apiKey} placeholder="sk-… / sk-ant-…" onChange={(e) => setApiKey(e.target.value)} /></div>
        </div>
        <div style={{ marginTop: 14 }}><button onClick={save} disabled={busy || !apiKey}>Save key</button></div>
      </div>
      <div className="card">
        <h2>Stored provider keys</h2>
        {rows.length === 0 ? <p className="muted small">None yet.</p> : (
          <table>
            <thead><tr><th>Provider</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.provider}>
                  <td>{r.provider}</td>
                  <td className="muted">{fmtDate(r.created_at)}</td>
                  <td><button className="danger-btn small-btn" onClick={() => del(r.provider)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ---------------- credits ---------------- */
function Credits({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<{ receiver_address: string; configured: boolean; chains: ChainInfo[] } | null>(null)
  const [credits, setCredits] = useState<{ balance_usd_micros: number; ledger: any[] } | null>(null)
  const [chain, setChain] = useState('base')
  const [txHash, setTxHash] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    api('/api/credits/deposit-info').then(setInfo).catch(() => {})
    api('/api/credits').then(setCredits).catch(() => {})
  }, [])
  useEffect(load, [load])
  const submit = async () => {
    setBusy(true)
    try {
      const r = await api('/api/credits/deposit', { method: 'POST', body: JSON.stringify({ chain, tx_hash: txHash.trim() }) })
      if (r.status === 'already_credited') toast('That deposit was already credited')
      else toast('Credited ' + fmtUsd(r.amount_usd_micros))
      setTxHash(''); load(); onChanged()
    } catch (e: any) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  return (
    <div>
      <div className="grid cols-3">
        <div className="stat" style={{ gridColumn: 'span 3' }}>
          <div className="label">Balance</div>
          <div className="value">{credits ? fmtUsd(credits.balance_usd_micros) : '…'}</div>
        </div>
      </div>
      <div className="card">
        <h2>Top up with on-chain transfer</h2>
        {!info?.configured ? (
          <p className="warn small">No platform receiver address configured yet (demo deployment).</p>
        ) : (
          <>
            <p className="muted small">Send USDC (Base) or USDG (Robinhood Chain) from a wallet registered to your account, then submit the transaction hash below. Verification is automatic and idempotent.</p>
            <div className="copyable" style={{ margin: '12px 0' }}>
              <span className="val">{info.receiver_address}</span>
              <button className="ghost small-btn" onClick={() => { navigator.clipboard.writeText(info.receiver_address); toast('Address copied') }}>Copy</button>
            </div>
            <table style={{ marginBottom: 14 }}>
              <thead><tr><th>Chain</th><th>Token</th></tr></thead>
              <tbody>
                {info.chains.map((c) => (
                  <tr key={c.id}><td>{c.name} <span className="muted small">({c.chainId})</span></td><td>{c.tokens.map((t) => t.symbol).join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <div>
                <label>Chain</label>
                <select value={chain} onChange={(e) => setChain(e.target.value)}>
                  {(info.chains || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ flex: 2 }}><label>Transaction hash</label><input value={txHash} className="mono" placeholder="0x…" onChange={(e) => setTxHash(e.target.value)} /></div>
            </div>
            <div style={{ marginTop: 14 }}><button onClick={submit} disabled={busy || !txHash.trim()}>Verify &amp; credit</button></div>
          </>
        )}
      </div>
      <div className="card">
        <h2>Ledger</h2>
        {credits?.ledger?.length ? (
          <table>
            <thead><tr><th>When</th><th>Kind</th><th>Reference</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {credits.ledger.map((l: any, i: number) => (
                <tr key={i}>
                  <td className="muted">{fmtDate(l.created_at)}</td>
                  <td><span className="pill">{l.kind}</span></td>
                  <td className="mono muted">{l.ref || '—'}</td>
                  <td style={{ textAlign: 'right' }} className={l.amount_usd_micros >= 0 ? 'ok' : ''}>{l.amount_usd_micros >= 0 ? '+' : ''}{fmtUsd(l.amount_usd_micros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted small">No activity yet.</p>}
      </div>
    </div>
  )
}

export { Landing, Overview, Keys, Byok, Credits }
