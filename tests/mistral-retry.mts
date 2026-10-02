const BASE = 'https://thirdeye-ai-alpha.vercel.app'
const fs = await import('node:fs')
const mk = fs.readFileSync('.env.production.local', 'utf8').match(/MASTER_KEY=([^\n]+)/)?.[1]
// reuse: sign in fresh, list models with auth, then mistral chat
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
const account = privateKeyToAccount(generatePrivateKey())
const nonce = (await (await fetch(BASE + '/api/auth/nonce')).json()).nonce
const msg = `${'thirdeye-ai-alpha.vercel.app'} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Thirdeye AI\n\nURI: https://thirdeye-ai-alpha.vercel.app\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now() + 600000).toISOString()}`
const sig = await account.signMessage({ message: msg })
const vr = await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: msg, signature: sig }) })
const cookie = (vr as any).headers.getSetCookie?.().join('; ') || vr.headers.get('set-cookie') || ''
await fetch(BASE + '/api/admin/credit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-master-key': mk }, body: JSON.stringify({ wallet: account.address, amount_usd_micros: 100000, reason: 'mistral-retry' }) })
const kr = await fetch(BASE + '/api/keys', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'm-retry' }) })
const secret = (await kr.json()).secret
const models = await (await fetch(BASE + '/api/v1/models', { headers: { authorization: 'Bearer ' + secret } })).json()
console.log('models:', (models.data || []).map((m: any) => m.id).join(', '))
const chat = await fetch(BASE + '/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: JSON.stringify({ model: 'mistral-small', messages: [{ role: 'user', content: 'One short sentence: what is a bonding curve?' }], max_tokens: 80 }) })
const b = await chat.json()
console.log('mistral-small:', chat.status, JSON.stringify(b?.choices?.[0]?.message?.content || b?.error || '').slice(0, 140))
