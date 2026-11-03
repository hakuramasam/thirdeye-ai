const BASE = 'https://thirdeye-ai-alpha.vercel.app'
let cookie = ''
const j = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers as any), 'content-type': 'application/json', cookie } })
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
const acct = privateKeyToAccount(generatePrivateKey())
const n = await j('/api/auth/nonce')
const message = `thirdeye.example wants you to sign in with your wallet:\n${acct.address}\n\nNonce: ${n.body?.nonce}\nIssued At: ${new Date().toISOString()}`
const signature = await acct.signMessage({ message })
const v = await j('/api/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) })
console.log('session:', v.status === 200 ? 'ok' : JSON.stringify(v.body).slice(0, 100))

// 1. create an intent (the memo)
const i = await j('/api/payments/intent', { method: 'POST', body: JSON.stringify({ purpose: 'api_credits', memo: 'Buying $5 API usage credits - test', expected_usd: 5 }) })
console.log('INTENT RAW:', JSON.stringify(i.body).slice(0, 300))
const intent = i.body?.intent
console.log('INTENT:', i.status, '| id:', intent?.id, '| purpose:', intent?.purpose, '| memo:', intent?.memo, '| expires:', intent?.expires_at)
console.log('receivers listed:', i.body?.how_to_pay?.receivers?.length, '| ttl min:', i.body?.how_to_pay?.expires_in_minutes)

// 2. bad purpose rejected
const bad = await j('/api/payments/intent', { method: 'POST', body: JSON.stringify({ purpose: 'free_money', expected_usd: 5 }) })
console.log('bad purpose:', bad.status, JSON.stringify(bad.body).slice(0, 80))

// 3. claim a REAL payment against that intent
const realTx = '0x0036b049b5c993c5c3cbb94cd8d8b7891c80640fe4cf8691e3ea4a06e8560613'
const r = await j('/api/credits/payment-review', { method: 'POST', body: JSON.stringify({ chain_id: 8453, tx_hash: realTx, intent_id: intent?.id }) })
console.log('CLAIM:', r.status, '| intent on payment:', r.body?.intent?.purpose, '/', JSON.stringify(r.body?.intent?.memo), '| refusal:', r.body?.refusal?.code, '| payment_id:', r.body?.payment_id)

// 4. the record
const list = await j('/api/payments')
console.log('PAYMENT RECORD:', JSON.stringify(list.body?.payments?.[0]))

// 5. claiming someone else's intent must fail
const r2 = await j('/api/credits/payment-review', { method: 'POST', body: JSON.stringify({ chain_id: 8453, tx_hash: realTx, intent_id: 'pi_doesnotexist' }) })
console.log('foreign intent:', r2.status, JSON.stringify(r2.body).slice(0, 70))
console.log('TEMP=' + acct.address)
