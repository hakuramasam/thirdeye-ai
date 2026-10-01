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
  return api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) })
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
