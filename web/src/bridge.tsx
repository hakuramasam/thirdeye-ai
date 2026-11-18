import { useState } from 'react'
import { api, getActiveProvider, getActiveChainId, toast } from './wallet'
import { toRawUnits, fmtUsdc } from './bridgeAmount'

/**
 * Cross-chain funding for the deposit page (quote-only).
 *
 * The quote comes from our own /api/credits/bridge-quote, which asks LI.FI for a route onto USDC on Base.
 * The transaction is signed by the user's own wallet: the platform never holds the funds and never signs
 * for them. Credit is issued later, by the normal onchain verification, once the USDC actually lands.
 */

type SourceChain = { id: number; name: string; usdc: `0x${string}` }

// USDC per source chain. The destination is pinned server-side, so a caller cannot route funds elsewhere.
const SOURCES: SourceChain[] = [
  { id: 42161, name: 'Arbitrum', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  { id: 10, name: 'OP Mainnet', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  { id: 137, name: 'Polygon', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { id: 1, name: 'Ethereum', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
]

/** Raw 6-decimal units from a typed amount, without ever passing the value through a float. */
type Quote = {
  tool: string
  toAmount: string
  toAmountMin: string
  toAmountUsd: number
  executionDurationSeconds: number | null
  feeCosts: Array<{ name: string; amountUsd: number }>
  transactionRequest: { to: string; data: string; value: string; gasLimit?: string; chainId: number }
}

export function BridgeDeposit({ onSent }: { onSent?: (txHash: string, chainId: number) => void }) {
  const [sourceId, setSourceId] = useState(SOURCES[0].id)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const source = SOURCES.find((s) => s.id === sourceId) ?? SOURCES[0]

  const getQuote = async () => {
    setError(null)
    setQuote(null)
    setTxHash(null)
    const raw = toRawUnits(amount)
    if (!raw) {
      setError('Enter an amount with up to 6 decimals.')
      return
    }
    const provider = getActiveProvider()
    if (!provider) {
      setError('Connect a wallet first.')
      return
    }
    setBusy(true)
    try {
      const res = await api('/api/credits/bridge-quote', {
        method: 'POST',
        body: JSON.stringify({ fromChain: sourceId, fromToken: source.usdc, amountRaw: raw, fromAddress: '' }),
      })
      setQuote(res.quote as Quote)
    } catch (e: any) {
      const msg = String(e?.message || '')
      setError(
        msg.includes('below_minimum')
          ? 'That route comes back under $25 of measured USDC, and the bridge fee would eat most of it. Send at least $25.'
          : msg.includes('disabled') || msg.includes('not found')
            ? 'Bridging is not enabled yet.'
            : msg.includes('no_route')
              ? 'No route right now. Try a smaller amount or another chain.'
              : 'Could not fetch a quote. Try again in a moment.',
      )
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    const provider = getActiveProvider()
    if (!provider || !quote) return
    setBusy(true)
    setError(null)
    try {
      const active = getActiveChainId()
      if (active !== source.id) {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${source.id.toString(16)}` }],
        }).catch(() => { throw new Error('switch_failed') })
      }
      const tx = quote.transactionRequest
      const hash = (await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          to: tx.to,
          data: tx.data,
          value: tx.value && tx.value !== '0x0' ? tx.value : '0x0',
          ...(tx.gasLimit ? { gas: tx.gasLimit } : {}),
        }],
      })) as string
      setTxHash(hash)
      toast('Bridge sent. USDC arrives on Base shortly.')
      onSent?.(hash, source.id)
    } catch (e: any) {
      setError(e?.message === 'switch_failed' ? `Switch your wallet to ${source.name} to continue.` : 'The wallet did not send the transaction.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <h3>Or deposit from another chain</h3>
      <p className="muted small">
        Pay in USDC from {SOURCES.map((s) => s.name).join(', ')} and receive USDC on Base. Your wallet signs the
        bridge transaction. Credit is issued after the USDC lands on Base and is verified, not when the bridge reports done.
      </p>
      <div className="row">
        <div>
          <label>Source chain</label>
          <select value={sourceId} onChange={(e) => { setSourceId(Number(e.target.value)); setQuote(null); setTxHash(null) }}>
            {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label>Amount in USDC</label>
          <input value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); setTxHash(null) }} placeholder="25.00" inputMode="decimal" />
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <button className="ghost" onClick={getQuote} disabled={busy}>{busy && !quote ? 'Quoting…' : 'Get quote'}</button>
        </div>
      </div>
      {error && <p className="warn small">{error}</p>}
      {quote && !txHash && (
        <div className="copyable" style={{ display: 'block', margin: '12px 0' }}>
          <div className="mono small">{quote.tool} · you receive {fmtUsdc(quote.toAmount)} USDC on Base</div>
          <div className="muted small">
            Minimum received {fmtUsdc(quote.toAmountMin)} USDC
            {quote.executionDurationSeconds != null ? ` · about ${Math.max(1, Math.round(quote.executionDurationSeconds / 60))} min` : ''}
            {quote.feeCosts.length ? ` · fees ${quote.feeCosts.map((f) => `$${f.amountUsd.toFixed(4)} ${f.name}`).join(', ')}` : ''}
          </div>
          <button onClick={send} disabled={busy} style={{ marginTop: 10 }}>{busy ? 'Waiting for wallet…' : `Send from ${source.name}`}</button>
        </div>
      )}
      {txHash && (
        <p className="muted small">
          Sent: <span className="mono">{txHash.slice(0, 12)}…</span>. Once the USDC shows on Base, paste that
          Base transaction hash into the form above to claim the credit.
        </p>
      )}
    </div>
  )
}
