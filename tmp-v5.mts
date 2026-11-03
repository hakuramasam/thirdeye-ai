const BASE = 'https://thirdeye-ai-alpha.vercel.app'
let cookie = ''
const j = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers as any), 'content-type': 'application/json', cookie } })
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
// temp session
const { randomWallet } = await import('./tests/_wallet.mjs').catch(() => ({ randomWallet: null }))
const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
const pk = generatePrivateKey()
const acct = privateKeyToAccount(pk)
const now = new Date().toISOString()
const n = await j('/api/auth/nonce')
const nonce = n.body?.nonce
const message = `thirdeye.example wants you to sign in with your wallet:\n${acct.address}\n\nNonce: ${nonce}\nIssued At: ${now}`
const signature = await acct.signMessage({ message })
const v = await j('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) })
console.log('session:', v.status === 200 ? 'ok' : JSON.stringify(v.body).slice(0, 120))

const realTx = '0x0036b049b5c993c5c3cbb94cd8d8b7891c80640fe4cf8691e3ea4a06e8560613'
const r1 = await j('/api/credits/payment-review', { method: 'POST', body: JSON.stringify({ chain_id: 8453, tx_hash: realTx }) })
console.log('REAL tx:', r1.status, JSON.stringify(r1.body).slice(0, 260))

const r2 = await j('/api/credits/payment-review', { method: 'POST', body: JSON.stringify({ chain_id: 8453, tx_hash: '0x' + '11'.repeat(32) }) })
console.log('fake tx:', r2.status, '|', r2.body?.verification?.code, '-', String(r2.body?.verification?.message).slice(0, 70))

const r3 = await j('/api/credits/auto-convert/check', { method: 'POST', body: JSON.stringify({ chain_id: 56, token: '0x55d398326f99059fF775485246999027B3197955', amount: '5', decimals: 18 }) })
console.log('BSC USDT $5:', r3.status, JSON.stringify(r3.body).slice(0, 300))

const r4 = await j('/api/credits/auto-convert/check', { method: 'POST', body: JSON.stringify({ chain_id: 4663, token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', amount: '5', decimals: 6 }) })
console.log('Robinhood USDG $5:', r4.status, JSON.stringify(r4.body).slice(0, 220))

const di = await j('/api/credits/deposit-info')
console.log('deposit-info chains:', (di.body?.chains || []).map((c: any) => c.id).join(', '), '| receivers:', [di.body?.receiver_address, di.body?.agent_receiver].filter(Boolean).length)
console.log('TEMP=' + acct.address)
