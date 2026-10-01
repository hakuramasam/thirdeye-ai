import React, { useEffect, useState, useCallback } from 'react'
import './styles.css'

/* ---------------- types ---------------- */
export type User = { id: string; wallet: string; role: string }
export type KeyRow = { id: string; prefix: string; name: string; rpm: number; tpm: number; created_at: string; revoked_at: string | null }
export type ByokRow = { provider: string; created_at: string }
export type ModelRow = { model: string; provider: string; price_in_1m_usd_micros: number; price_out_1m_usd_micros: number }
export type AgentRow = {
  id: string; name: string; system_prompt: string; model: string
  mcp_servers: { name: string; url: string }[]
  x402_enabled: boolean; budget_usd_micros: number; max_steps: number
  cron: string | null; last_run_at: string | null; status: string; created_at: string
}
export type RunRow = { id: string; status: string; input: string; output: string | null; tool_calls: number; spend_usd_micros: number; error: string | null; created_at: string }
export type LedgerRow = { amount_usd_micros: number; kind: string; ref: string | null; created_at: string }
export type ChainInfo = { id: string; name: string; chainId: number; tokens: { symbol: string; address: string }[] }
type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, cb: (...args: any[]) => void): void
  removeListener?(event: string, cb: (...args: any[]) => void): void
}
type AnnouncedWallet = { info: { uuid: string; name: string; icon: string | null; rdns: string }, provider: Eip1193Provider }

const API = ''
const siweDomain = typeof location !== 'undefined' ? location.hostname || 'localhost' : 'localhost'

export async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error?.message || `Request failed (${res.status})`)
  return body
}

export function fmtUsd(micros: number | string): string {
  const v = Number(micros) / 1e6
  return '$' + (v >= 100 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))
}
export function fmtMicroPerM(micros: number): string {
  return '$' + (micros / 1e6).toFixed(micros < 100_000 ? 4 : 2) + '/1M'
}
export function short(addr: string): string {
  return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : ''
}
export function fmtDate(s: string): string {
  if (!s) return '—'
  const d = new Date(s)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* ---------------- toasts ---------------- */
let toastFn: ((msg: string, kind?: 'ok' | 'error') => void) | null = null
export function toast(msg: string, kind: 'ok' | 'error' = 'ok') { toastFn?.(msg, kind) }
export function Toasts() {
  const [items, setItems] = useState<{ id: number; msg: string; kind: string }[]>([])
  useEffect(() => {
    toastFn = (msg, kind = 'ok') => {
      const id = Date.now() + Math.random()
      setItems((prev) => [...prev, { id, msg, kind }])
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200)
    }
    return () => { toastFn = null }
  }, [])
  return (
    <>
      {items.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>
      ))}
    </>
  )
}

/* ---------------- wallet connect (EIP-6963 + SIWE) ---------------- */
function buildSiweMessage(opts: {
  domain: string; address: string; uri: string; nonce: string; chainId: number
}): string {
  const issued = new Date().toISOString()
  const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  return [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    opts.address,
    '',
    'Sign in to Thirdeye AI',
    '',
    `URI: ${opts.uri}`,
    'Version: 1',
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${issued}`,
    `Expiration Time: ${expiry}`,
  ].join('\n')
}

let activeProvider: Eip1193Provider | null = null
let activeChainId = 0
const chainListeners: ((chainId: number) => void)[] = []
export function getActiveProvider(): Eip1193Provider | null { return activeProvider }
export function getActiveChainId(): number { return activeChainId }
export function onChainChanged(cb: (chainId: number) => void): () => void {
  chainListeners.push(cb)
  return () => { const i = chainListeners.indexOf(cb); if (i >= 0) chainListeners.splice(i, 1) }
}
function watchProvider(provider: Eip1193Provider, chainId: number) {
  activeProvider = provider
  activeChainId = chainId
  provider.on?.('chainChanged', (hex: string) => {
    activeChainId = parseInt(hex, 16) || 0
    chainListeners.forEach((cb) => cb(activeChainId))
  })
  chainListeners.forEach((cb) => cb(activeChainId))
}

export async function signInWith(provider: Eip1193Provider): Promise<{ user: User; mode: string }> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0]
  if (!address) throw new Error('No account returned by wallet')
  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
  const chainId = parseInt(chainIdHex, 16) || 8453
  const { nonce } = await api('/api/auth/nonce')
  const message = buildSiweMessage({
    domain: siweDomain,
    address,
    uri: location.origin,
    nonce,
    chainId,
  })
  const signature = (await provider.request({ method: 'personal_sign', params: [message, address] })) as string
  const res = await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) })
  watchProvider(provider, chainId)
  return res
}

export function useWallets() {
  const [wallets, setWallets] = useState<AnnouncedWallet[]>([])
  useEffect(() => {
    const found: AnnouncedWallet[] = []
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.info?.uuid) {
        found.push(detail)
        setWallets([...found])
      }
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    const t = setTimeout(() => {
      if ((window as any).ethereum && found.length === 0) {
        found.push({
          info: { uuid: 'injected', name: 'Injected Wallet', icon: null, rdns: 'injected' },
          provider: (window as any).ethereum,
        })
        setWallets([...found])
      }
    }, 250)
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      clearTimeout(t)
    }
  }, [])
  return wallets
}


/* ---------------- supported chains (Base + Robinhood Chain) ---------------- */
export type SupportedChain = { id: string; name: string; chainId: number; hexId: string; addParams: object }
export const SUPPORTED_CHAINS: SupportedChain[] = [
  {
    id: 'base', name: 'Base', chainId: 8453, hexId: '0x2105',
    addParams: {
      chainId: '0x2105', chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
    },
  },
  {
    id: 'robinhood', name: 'Robinhood Chain', chainId: 4663, hexId: '0x1237',
    addParams: {
      chainId: '0x1237', chainName: 'Robinhood Chain',
      nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    },
  },
]
export function chainById(chainId: number): SupportedChain | undefined {
  return SUPPORTED_CHAINS.find((c) => c.chainId === chainId)
}
export async function readChainId(provider: Eip1193Provider): Promise<number> {
  try {
    const hex = (await provider.request({ method: 'eth_chainId' })) as string
    return parseInt(hex, 16) || 0
  } catch { return 0 }
}
/** Switch (or add) the wallet to a supported chain. Throws on user rejection. */
export async function switchToChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const chain = chainById(chainId)
  if (!chain) throw new Error('Unsupported chain')
  if ((await readChainId(provider)) === chainId) return
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.hexId }] })
  } catch (e: any) {
    const code = e?.code ?? e?.data?.originalError?.code
    const unknown = code === 4902 || code === -32603 || /Unrecognized chain|unrecognized chain/i.test(e?.message || '')
    if (!unknown) throw e
    await provider.request({ method: 'wallet_addEthereumChain', params: [chain.addParams] })
  }
  if ((await readChainId(provider)) !== chainId) throw new Error('Network switch was not applied')
  activeChainId = chainId
  chainListeners.forEach((cb) => cb(activeChainId))
}

/* ---------------- WalletConnect (mobile-friendly popup) ---------------- */
export function walletConnectConfigured(): boolean {
  return !!((import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID)
}
export async function connectWalletConnect(): Promise<Eip1193Provider> {
  const projectId = (import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID as string | undefined
  if (!projectId) throw new Error('WalletConnect is not configured on this deployment yet')
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider')
  const provider = await EthereumProvider.init({
    projectId,
    chains: [8453],
    optionalChains: [4663],
    showQrModal: true,
    metadata: {
      name: 'Thirdeye AI',
      description: 'OpenAI-compatible AI gateway with USDC prepaid credits',
      url: typeof location !== 'undefined' ? location.origin : 'https://thirdeye-ai-alpha.vercel.app',
      icons: [],
    },
  })
  await provider.connect()
  return provider as unknown as Eip1193Provider
}

/* ---------------- network switch prompt ---------------- */
export function NetworkPrompt({ onSwitched, onDismiss }: { onSwitched?: (chainId: number) => void; onDismiss: () => void }) {
  const [busy, setBusy] = useState(0)
  const doSwitch = async (chainId: number) => {
    const provider = getActiveProvider()
    if (!provider) { onDismiss(); return }
    setBusy(chainId)
    try {
      await switchToChain(provider, chainId)
      toast('Switched to ' + (chainById(chainId)?.name ?? chainId))
      onSwitched?.(chainId)
      onDismiss()
    } catch (e: any) {
      toast(e?.message || 'Network switch failed', 'error')
    } finally { setBusy(0) }
  }
  return (
    <div className="net-overlay">
      <div className="card net-modal">
        <h2>Switch network</h2>
        <p className="muted small">
          Thirdeye AI runs on <strong>Base</strong> and <strong>Robinhood Chain</strong>.
          Your wallet is on an unsupported network (chain {getActiveChainId()}).
        </p>
        <div className="wallet-list">
          {SUPPORTED_CHAINS.map((c) => (
            <button key={c.id} className="wallet-btn" disabled={!!busy} onClick={() => doSwitch(c.chainId)}>
              <span className="brand"><span className="eye" /></span>
              {c.name}{busy === c.chainId ? ' — switching…' : ''}
            </button>
          ))}
        </div>
        <button className="ghost small-btn" style={{ marginTop: 12 }} onClick={onDismiss}>Later</button>
      </div>
    </div>
  )
}

/* ---------------- header chain badge ---------------- */
export function ChainBadge({ onNeedSwitch }: { onNeedSwitch: () => void }) {
  const [chainId, setChainId] = useState(getActiveChainId())
  useEffect(() => onChainChanged(setChainId), [])
  if (!getActiveProvider()) return null
  const chain = chainById(chainId)
  return (
    <button
      className={'chip net-chip' + (chain ? '' : ' bad')}
      title={chain ? 'Connected to ' + chain.name : 'Unsupported network — click to switch to Base or Robinhood Chain'}
      onClick={() => { if (!chain) onNeedSwitch() }}
    >
      {chain ? chain.name : 'Wrong network'}
    </button>
  )
}
