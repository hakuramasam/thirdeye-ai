const BASE = 'https://thirdeeye-ai-alpha.vercel.app'
let cookie = ''
const j = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers as any), ...(cookie ? { cookie } : {}) } })
  const sc = res.headers.getSetCookie?.() || []
  if (sc.length) cookie = sc.map((c: string) => c.split(';')[0]).join('; ')
  const text = await res.text()
  let body: any = {}
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 200) } }
  return { status: res.status, body, text }
}
const post = (p: string, data: any) =>
  j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })

const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
const account = privateKeyToAccount(generatePrivateKey())
const n = await j('/api/auth/nonce')
const msg = `thirdeeye-ai-alpha.vercel.app wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to Thirdeye AI\n\nURI: https://thirdeeye-ai-alpha.vercel.app\nVersion: 1\nChain ID: 8453\nNonce: ${n.body.nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now()+600000).toISOString()}`
const sig = await account.signMessage({ message: msg })
const verify = await post('/api/auth/verify', { message: msg, signature: sig })
console.log('1. sign-in:', verify.status, verify.body.user ? 'OK cookie=' + (cookie ? 'captured' : 'MISSING') : JSON.stringify(verify.body).slice(0,200))

const agent = await post('/api/agents', { name: 'Bug Test Agent', system_prompt: 'You are a helpful assistant.', model: 'gpt-oss-20b' })
console.log('2. create agent:', agent.status, agent.body.agent ? 'OK id=' + agent.body.agent.id : JSON.stringify(agent.body).slice(0, 300))
if (!agent.body.agent) process.exit(1)

const run = await post(`/api/agents/${agent.body.agent.id}/run`, { input: 'Say hello in one short sentence.' })
console.log('3. send message:', run.status)
if (run.status !== 200) { console.log('   error:', JSON.stringify(run.body).slice(0, 400)); process.exit(1) }
console.log('   keys:', Object.keys(run.body), '| preview:', JSON.stringify(run.body).slice(0, 300))
