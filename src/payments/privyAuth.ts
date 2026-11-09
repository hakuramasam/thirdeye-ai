/**
 * Privy authorization signatures.
 *
 * The wallet we convert deposits from is owned by a key quorum, so every state-changing call to
 * Privy must carry a signature proving our backend authorised it. Privy does not accept the app
 * secret alone for those calls: the request is signed with a P-256 authorization key and the
 * result travels in the `privy-authorization-signature` header.
 *
 * The signature covers the exact request: a JWT whose payload is a JSON object describing the
 * method, url, body and Privy headers. That is why the caller must pass the same body it will
 * send; a re-serialised body with a different key order will not verify.
 */
import { createPrivateKey, sign as signBytes, type KeyObject } from 'node:crypto'

export type AuthorizationRequest = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  body: unknown
  appId: string
  idempotencyKey?: string
  requestExpiry?: number
}

export type SignaturePayload = {
  version: 1
  method: string
  url: string
  body: unknown
  headers: Record<string, string>
}

/**
 * Accepts the shapes the Privy dashboard hands out: a bare base64 DER body, a `wallet-auth:`
 * prefixed value, or a PEM. Returns a key object, or throws with a readable reason.
 */
export function normalizationError(raw: string): string | null {
  if (!raw || !raw.trim()) return 'authorization private key is empty'
  try {
    loadAuthorizationKey(raw)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'authorization private key could not be read'
  }
}

export function loadAuthorizationKey(raw: string): KeyObject {
  const trimmed = raw.trim().replace(/^wallet-auth:/i, '').trim()
  if (trimmed.includes('-----BEGIN')) {
    const key = createPrivateKey({ key: trimmed, format: 'pem' })
    if (key.asymmetricKeyType !== 'ec') throw new Error(`expected an EC key, got ${key.asymmetricKeyType}`)
    return key
  }
  // Bare base64 DER: the dashboard pastes the PKCS8 body without PEM armour.
  const der = Buffer.from(trimmed, 'base64')
  if (der.length < 32) throw new Error('authorization private key looks truncated')
  try {
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    if (key.asymmetricKeyType !== 'ec') throw new Error(`expected an EC key, got ${key.asymmetricKeyType}`)
    // OpenSSL reports the same curve as prime256v1; both names mean P-256.
    const curve = key.asymmetricKeyDetails?.namedCurve ?? ''
    if (curve && !/^(P-256|prime256v1|secp256r1)$/i.test(curve)) {
      throw new Error(`expected curve P-256, got ${curve}`)
    }
    return key
  } catch (err) {
    throw new Error(`authorization private key is not a valid P-256 PKCS8 key (${err instanceof Error ? err.message : 'unknown'})`)
  }
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The JSON object Privy tells you to sign. Header values must match the ones actually sent. */
export function buildSignaturePayload(req: AuthorizationRequest): SignaturePayload {
  const headers: Record<string, string> = { 'privy-app-id': req.appId }
  if (req.idempotencyKey) headers['privy-idempotency-key'] = req.idempotencyKey
  if (req.requestExpiry) headers['privy-request-expiry'] = String(req.requestExpiry)
  return { version: 1, method: req.method, url: req.url, body: req.body, headers }
}

/**
 * RFC 8785-style canonical JSON: object keys sorted, no whitespace. Privy signs this exact byte
 * sequence, so a body that differs only in key order produces a signature it cannot verify.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * Privy reads a base64 signature over sha256(canonical payload). It is not a JWT: the signature
 * is DER-encoded and every signature travels as plain base64, comma separated when a quorum
 * needs more than one.
 */
export function signAuthorization(payload: SignaturePayload, key: KeyObject): string {
  const bytes = Buffer.from(canonicalJson(payload))
  const signature = signBytes('sha256', bytes, { key, dsaEncoding: 'der' })
  return signature.toString('base64')
}

export type PrivyAuthEnv = {
  appId: string
  walletId: string
  appSecret: string
  authorizationKeyId?: string
  authorizationPrivateKey?: string
}

export class PrivyAuthorizationError extends Error {}

/**
 * Build the headers for a Privy call, signing when a key is configured. Without one we return
 * only the basic headers; the caller's request will be refused by Privy, which is the honest
 * outcome rather than silently pretending authority we do not have.
 */
export function authorizationHeaders(
  env: PrivyAuthEnv,
  input: { method: AuthorizationRequest['method']; path: string; body: unknown; idempotencyKey?: string }
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'privy-app-id': env.appId }
  if (input.idempotencyKey) headers['privy-idempotency-key'] = input.idempotencyKey
  if (!env.authorizationPrivateKey) return headers
  const key = loadAuthorizationKey(env.authorizationPrivateKey)
  const payload = buildSignaturePayload({
    method: input.method,
    url: `https://api.privy.io${input.path}`,
    body: input.body,
    appId: env.appId,
    idempotencyKey: input.idempotencyKey,
  })
  headers['privy-authorization-signature'] = signAuthorization(payload, key)
  return headers
}
