import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { validateSecrets, type SecretProblem } from './security.js'

/** Central typed config. Everything optional for dev/demo; set in production. */
const num = (v: string | undefined, d: number) => (v == null || v === '' ? d : Number(v))

/**
 * A millisecond setting that must stay usable. NaN and negative values would otherwise reach the
 * retry guards, where "wait > NaN" is false and the caps quietly stop working, so an unusable
 * value falls back to the default instead of disabling a guard.
 */
export const msSetting = (v: string | undefined, d: number): number => {
  if (v == null || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : d
}

/** A millisecond setting that must also stay inside a range where it still means something. */
export const msSettingBetween = (v: string | undefined, d: number, lo: number, hi: number): number => {
  const n = msSetting(v, d)
  if (n < lo || n > hi) return d
  return n
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 8787),
  isServerless: !!process.env.VERCEL,

  /**
   * PREVIEW_DATABASE_URL exists because DATABASE_URL could not be split per target:
   * a preview-scoped DATABASE_URL is set in the Vercel project and still does not reach
   * the preview runtime, which keeps booting against the production database. A separate
   * name is honoured, so a preview that sets it talks to a Neon branch and can never
   * write live rows. Unset in production, so production behaviour is unchanged.
   */
  databaseUrl: process.env.PREVIEW_DATABASE_URL || process.env.DATABASE_URL || '',
  pgliteDir: process.env.PGLITE_DIR ?? (process.env.VERCEL ? 'memory://' : '.data/thirdeye'),

  sessionSecret: process.env.SESSION_SECRET || 'thirdeye-dev-session-secret',
  masterKey: process.env.MASTER_KEY || 'thirdeye-dev-master-key',

  platformReceiverAddress: (process.env.PLATFORM_RECEIVER_ADDRESS || '').toLowerCase(),
  /** Second receiving wallet (Privy agent wallet). Payments to either are ours. */
  platformAgentReceiver: (process.env.PLATFORM_AGENT_RECEIVER || '').toLowerCase(),
  /** Splits automation account: converts incoming tokens and forwards to the vault. */
  platformAutomationReceiver: (process.env.PLATFORM_AUTOMATION_RECEIVER || '').toLowerCase(),
  /**
   * Default deposit address shown to users (Alchemy agent wallet). Kept separate from
   * platformAgentReceiver on purpose: that one doubles as the Privy signer identity, so
   * pointing it at a wallet this server cannot sign for would mislabel every conversion.
   */
  platformSponsorReceiver: (process.env.PLATFORM_SPONSORED_RECEIVER || '').toLowerCase(),
  platformMarginPct: num(process.env.PLATFORM_MARGIN_PCT, 10),

  /** Platform token (THIRDEYE). Set once the token exists; deposits accept it automatically. */
  platformTokenAddress: (process.env.PLATFORM_TOKEN_ADDRESS || '').toLowerCase(),
  platformTokenSymbol: process.env.PLATFORM_TOKEN_SYMBOL || 'THIRDEYE',
  platformTokenDecimals: num(process.env.PLATFORM_TOKEN_DECIMALS, 18),
  /** Credit premium for paying in the platform token, in basis points (e.g. 1000 = +10%). */
  platformTokenBonusBps: num(process.env.PLATFORM_TOKEN_BONUS_BPS, 0),
  /** Deposit guards for the platform token while its market is thin. */
  platformTokenMaxDepositUsd: num(process.env.PLATFORM_TOKEN_MAX_DEPOSIT_USD, 25),
  platformTokenMinLiquidityUsd: num(process.env.PLATFORM_TOKEN_MIN_LIQUIDITY_USD, 5000),
  /**
   * Ops-published USD price per whole platform token. When set, platform-token deposits are
   * valued by this rate instead of a market read: the token's only pool is one we run, so
   * crediting off its spot price would be circular. Unset means deposits fall back to the
   * public GeckoTerminal read and are refused while no real market exists.
   */
  platformTokenUsdRate: num(process.env.PLATFORM_TOKEN_USD_RATE, 0),

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

  /** Telegram community bot (optional) */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAdminIds: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean),
  telegramBotId: process.env.TELEGRAM_BOT_ID || '',
  cronSecret: process.env.CRON_SECRET || '',

  /**
   * How long one agent run may spend waiting out provider rate limits, in total across its steps.
   * The function ceiling is 60s, so the default leaves room to record the run and respond.
   */
  agentRetryWaitMs: msSetting(process.env.AGENT_RETRY_WAIT_MS, 50_000),

  /**
   * The invocation ceiling a run plans against. The platform kills the function at 60s, so work
   * (including provider calls) must be finished with time left to record the run and audit it.
   */
  // Below 20s there is no room for a call plus the 5s finalization reserve, so every run would
  // fail before its first model call. Above 60s a run would plan past the platform's kill.
  agentRunCeilingMs: msSettingBetween(process.env.AGENT_RUN_CEILING_MS, 60_000, 20_000, 60_000),

  /** Hosts allowed to be private for MCP/HTTP egress (comma separated). Empty by default. */
  mcpAllowedHosts: (process.env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  /** Read-only repo access for team agents (GitHub REST). Absent = tool unavailable. */
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || 'hakuramasam/thirdeye-ai',
  githubRef: process.env.GITHUB_REPO_REF || 'main',
}

/**
 * Every wallet that is ours, in one place. Verification must accept a deposit to any of them,
 * otherwise an address we advertise is an address we refuse to credit.
 */
export function platformReceivers(): string[] {
  return [
    env.platformReceiverAddress,
    env.platformAgentReceiver,
    env.platformAutomationReceiver,
    env.platformSponsorReceiver,
  ].filter(Boolean)
}

/** Where users are told to send funds: the sponsored wallet when one is configured, else the vault. */
export function depositAddress(): string {
  return env.platformSponsorReceiver || env.platformReceiverAddress
}

export const newId = (): string => randomBytes(12).toString('hex')
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * AES-256-GCM encrypt/decrypt for BYOK keys at rest.
 *
 * Ciphertext format is `v1.<iv>.<tag>.<data>`, base64url, with a fresh 12-byte IV per record and
 * the GCM auth tag stored alongside so tampering is detected rather than decrypted. The version
 * prefix exists so a future key-derivation change can be introduced without having to guess how
 * to read old rows: unprefixed three-part values are the original format and still decrypt.
 *
 * Rotation is supported without a downtime window. When `MASTER_KEY_PREVIOUS` is set, a payload
 * that fails the current key is retried against the previous one, and `decryptSecretDetailed`
 * reports that it was rotated so the caller can re-encrypt it under the current key. Failures
 * are classified and never echo the ciphertext or any partial plaintext into the error.
 */
function key32From(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}
function key32(): Buffer {
  // Read through process.env so a rotation takes effect without a code path that caches the key,
  // and so tests can swap keys. Boot-time validation above still guarantees a safe value in
  // production; env.masterKey is only the fallback for a validated boot.
  return key32From(process.env.MASTER_KEY || env.masterKey)
}
function previousKey32(): Buffer | null {
  const prev = process.env.MASTER_KEY_PREVIOUS || ''
  if (!prev || prev === env.masterKey) return null
  return key32From(prev)
}

export class SecretDecryptError extends Error {
  code: 'decryption_failed' | 'malformed_payload'
  constructor(code: 'decryption_failed' | 'malformed_payload') {
    super(
      code === 'malformed_payload'
        ? 'Encrypted secret is malformed and cannot be read with any configured key'
        : 'Encrypted secret cannot be read with the configured key'
    )
    this.name = 'SecretDecryptError'
    this.code = code
  }
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key32(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`
}

function decryptWith(key: Buffer, ivb: string, tagb: string, data: string): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64url'))
  d.setAuthTag(Buffer.from(tagb, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
}

/** Decrypt and report whether the previous key had to be used, so the row can be re-wrapped. */
export function decryptSecretDetailed(payload: string): { plain: string; rotated: boolean } {
  const parts = String(payload ?? '').split('.')
  if (parts[0] === 'v1' && parts.length !== 4) throw new SecretDecryptError('malformed_payload')
  const versioned = parts[0] === 'v1' && parts.length === 4
  const body = versioned ? parts.slice(1) : parts
  if (body.length !== 3 || body.some((p) => !p)) throw new SecretDecryptError('malformed_payload')
  const [ivb, tagb, data] = body

  try {
    return { plain: decryptWith(key32(), ivb, tagb, data), rotated: false }
  } catch (primaryError) {
    const prev = previousKey32()
    if (!prev) throw new SecretDecryptError('decryption_failed')
    try {
      return { plain: decryptWith(prev, ivb, tagb, data), rotated: true }
    } catch {
      // Report the classified failure, never the underlying crypto error text.
      throw new SecretDecryptError('decryption_failed')
    }
  }
}

export function decryptSecret(payload: string): string {
  return decryptSecretDetailed(payload).plain
}

/** Re-encrypt a payload under the current key, for migrating rows after a rotation. */
export function reencryptSecret(payload: string): { plain: string; ciphertext: string; rotated: boolean } {
  const { plain, rotated } = decryptSecretDetailed(payload)
  return { plain, ciphertext: encryptSecret(plain), rotated }
}


// Fail closed, but legibly: a production boot with a development or short secret still refuses
// to serve anything, it just says so now. The refusal used to be a module-scope throw, which
// surfaced as a bare 500 on every route including the health endpoint. The problems are exported
// instead and config-guard.ts turns them into a 503 that names the variable, so the fix is one
// environment change rather than a hunt. No handler can run while this list is non-empty.
export const secretProblems: SecretProblem[] = validateSecrets({
  sessionSecret: process.env.SESSION_SECRET,
  masterKey: process.env.MASTER_KEY,
  nodeEnv: process.env.NODE_ENV,
})

/** True when this process may serve requests: its signing secrets passed validation. */
export const configOk = secretProblems.length === 0
