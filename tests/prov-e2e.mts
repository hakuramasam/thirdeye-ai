// Real-provider E2E against production
const BASE = 'https://thirdeye-ai-alpha.vercel.app'
const DOMAIN = 'thirdeye-ai-alpha.vercel.app'
const fs = await import('node:fs')
const mk = fs.readFileSync('.env.production.local', 'utf8').match(/MASTER_KEY=([^\n]+)/)?.[1]
const j = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(BASE + path, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, headers: res.headers }
}
const post = (p: string, data: any, headers: Record<string, string> = {}) =>
  j(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })

// sign in
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
const account = privateKeyToAccount(generatePrivateKey())
const nonceRes = await j('/api/auth/nonce')
const msg = `${DOMAIN} wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Thirdeye AI\n\nURI: https://${DOMAIN}\nVersion: 1\nChain ID: 8453\nNonce: ${nonceRes.body.nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now() + 600000).toISOString()}`
const signature = await account.signMessage({ message: msg })
const verify = await post('/api/auth/verify', { message: msg, signature })
const cookie = (verify.headers.getSetCookie?.() || []).join('; ')
console.log('1. sign-in:', verify.status)

// ops credit $5
const credit = await post('/api/admin/credit', { wallet: account.address, amount_usd_micros: 5000000, reason: 'provider-e2e-test' }, { 'x-master-key': mk })
console.log('2. ops credit:', credit.status, 'balance_usd_micros:', credit.body.balance_usd_micros)

// create API key
const keyRes = await post('/api/keys', { name: 'prov-test' }, { cookie })
const secret = keyRes.body.secret
console.log('3. key:', keyRes.status, secret ? 'issued' : 'FAIL')

// models list shows new entries
const models = await j('/api/v1/models')
const ids = (models.body.data || []).map((m: any) => m.id)
console.log('4. models:', ids.join(', '))

// real groq chat
const gpt = await post('/api/v1/chat/completions', { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'In one short sentence, what is a bonding curve?' }], max_completion_tokens: 200 }, { authorization: 'Bearer ' + secret })
console.log('5. gpt-oss-120b:', gpt.status, JSON.stringify(gpt.body?.choices?.[0]?.message?.content || gpt.body?.error || '').slice(0, 120))
console.log('   usage:', JSON.stringify(gpt.body?.usage || {}))

// real groq streaming
const sres = await fetch(BASE + '/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: JSON.stringify({ model: 'gpt-oss-20b', messages: [{ role: 'user', content: 'count 1 to 5' }], stream: true, max_completion_tokens: 200 }) })
const stext = await sres.text()
console.log('6. gpt-oss-20b stream:', sres.status, 'content-type', sres.headers.get('content-type'), '| sample:', stext.match(/"content":"[^"]{3,40}/)?.[0]?.slice(0, 60))

// real mistral chat
const ms = await post('/api/v1/chat/completions', { model: 'mistral-small', messages: [{ role: 'user', content: 'In one short sentence, what is a bonding curve?' }], max_tokens: 100 }, { authorization: 'Bearer ' + secret })
console.log('7. mistral-small:', ms.status, JSON.stringify(ms.body?.choices?.[0]?.message?.content || ms.body?.error || '').slice(0, 120))

// tools test on groq
const tool = await post('/api/v1/chat/completions', { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'What is 21 * 2? Use the calculator tool.' }], tools: [{ type: 'function', function: { name: 'calculator', description: 'calculate a math expression', parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } } }], max_completion_tokens: 300 }, { authorization: 'Bearer ' + secret })
console.log('8. tool call:', tool.status, 'tool_calls:', JSON.stringify(tool.body?.choices?.[0]?.message?.tool_calls || tool.body?.error || '').slice(0, 100))

// balance after
const credits = await j('/api/credits', { headers: { cookie } })
console.log('9. balance after:', credits.body.balance_usd_micros, 'micros, ledger rows:', credits.body.ledger?.length)

// admin endpoint rejects without key
const nokey = await post('/api/admin/credit', { wallet: account.address, amount_usd_micros: 100 })
console.log('10. admin no-key rejected:', nokey.status === 403 ? 'OK' : 'FAIL ' + nokey.status)
