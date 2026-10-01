// End-to-end over real HTTP against the local server on :8791
const BASE = 'http://localhost:8791'
const j = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(BASE + path, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, headers: res.headers }
}
const post = (p: string, data: any, headers: Record<string, string> = {}) =>
  j(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })

// 1. static dashboard
const idx = await fetch(BASE + '/')
console.log('1. dashboard html:', idx.status, (await idx.text()).includes('Thirdeye') ? 'branded OK' : 'MISSING BRAND')

// 2. SIWE sign-in
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
const account = privateKeyToAccount(generatePrivateKey())
const nonceRes = await j('/api/auth/nonce')
const msg = `localhost wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Thirdeye AI\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 8453\nNonce: ${nonceRes.body.nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now() + 600000).toISOString()}`
const signature = await account.signMessage({ message: msg })
const verify = await post('/api/auth/verify', { message: msg, signature })
const cookie = (verify.headers.getSetCookie?.() || []).join('; ') || ''
console.log('2. siwe verify:', verify.status, verify.body.user?.wallet === account.address.toLowerCase() ? 'OK' : 'FAIL')
const auth = { cookie, 'x-session-token': verify.body.token || '' }

// 3. create API key
const keyRes = await post('/api/keys', { name: 'e2e-key' }, { cookie })
const secret = keyRes.body.secret
console.log('3. api key create:', keyRes.status, secret?.startsWith('sk-thirdeye-') ? 'OK' : 'FAIL: ' + JSON.stringify(keyRes.body).slice(0, 200))

// 4. list models
const models = await j('/api/v1/models')
console.log('4. v1 models:', models.status, (models.body.data || []).length, 'models')

// 5. chat completion (mock model, key auth)
const chat = await post('/api/v1/chat/completions', {
  model: 'thirdeye-mock',
  messages: [{ role: 'user', content: 'Hello Thirdeye' }],
}, { authorization: 'Bearer ' + secret })
const content = chat.body?.choices?.[0]?.message?.content
console.log('5. chat completion:', chat.status, chat.body?.usage ? `usage pt=${chat.body.usage.prompt_tokens} ct=${chat.body.usage.completion_tokens}` : JSON.stringify(chat.body).slice(0, 200))

// 6. streaming
const streamRes = await fetch(BASE + '/api/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
  body: JSON.stringify({ model: 'thirdeye-mock', messages: [{ role: 'user', content: 'stream test' }], stream: true }),
})
const text = await streamRes.text()
console.log('6. streaming:', streamRes.status, streamRes.headers.get('content-type'), text.split('\n').filter((l) => l.startsWith('data:')).length, 'SSE events')

// 7. bad key -> 401
const bad = await post('/api/v1/chat/completions', { model: 'thirdeye-mock', messages: [] }, { authorization: 'Bearer sk-thirdeye-deadbeef' })
console.log('7. bad key rejected:', bad.status === 401 ? 'OK' : 'FAIL ' + bad.status)

// 8. agent create + run via HTTP
const agentRes = await post('/api/agents', { name: 'e2e-agent', system_prompt: 'test agent', model: 'thirdeye-mock' }, { cookie })
const runRes = await post(`/api/agents/${agentRes.body.agent.id}/run`, { input: 'ping' }, { cookie })
console.log('8. agent run:', agentRes.status, runRes.status, runRes.body.status)

// 9. stats endpoints
const me = await j('/api/stats/me', { headers: { cookie } })
console.log('9. stats/me:', me.status, Array.isArray(me.body) ? me.body.length + ' days' : 'FAIL')

// 10. deposit-info
const dep = await j('/api/credits/deposit-info', { headers: { cookie } })
console.log('10. deposit-info:', dep.status, dep.body.configured ? 'receiver configured' : 'no receiver (env)')

// 11. cron endpoint
const cron = await j('/api/cron/agents', { method: 'GET' })
console.log('11. cron no-secret:', cron.status === 401 ? 'OK (401)' : 'FAIL ' + cron.status)
