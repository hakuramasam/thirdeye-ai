import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'

/** Central typed config. Everything optional for dev/demo; set in production. */
const num = (v: string | undefined, d: number) => (v == null || v === '' ? d : Number(v))

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 8787),
  isServerless: !!process.env.VERCEL,

  databaseUrl: process.env.DATABASE_URL || '',
  pgliteDir: process.env.PGLITE_DIR ?? (process.env.VERCEL ? 'memory://' : '.data/thirdeye'),

  sessionSecret: process.env.SESSION_SECRET || 'thirdeye-dev-session-secret',
  masterKey: process.env.MASTER_KEY || 'thirdeye-dev-master-key',

  platformReceiverAddress: (process.env.PLATFORM_RECEIVER_ADDRESS || '').toLowerCase(),
  platformMarginPct: num(process.env.PLATFORM_MARGIN_PCT, 10),

  /** Platform provider keys, any OpenAI-based provider: PROV_<NAME>_API_KEY */
  providerKeys: (() => {
    const m: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      const mm = /^PROV_([A-Z0-9]+)_API_KEY$/.exec(k)
      if (mm && v) m[mm[1].toLowerCase()] = v
    }
    return m
  })(),

  agentWalletKey: process.env.AGENT_WALLET_PRIVATE_KEY || '',
  cronSecret: process.env.CRON_SECRET || '',
}

export const newId = (): string => randomBytes(12).toString('hex')
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** AES-256-GCM encrypt/decrypt for BYOK keys at rest. */
function key32(): Buffer {
  return createHash('sha256').update(env.masterKey).digest()
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key32(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`
}
export function decryptSecret(payload: string): string {
  const [ivb, tagb, data] = payload.split('.')
  const d = createDecipheriv('aes-256-gcm', key32(), Buffer.from(ivb, 'base64url'))
  d.setAuthTag(Buffer.from(tagb, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
}
