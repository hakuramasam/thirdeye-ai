# BYOK encryption, key storage and rotation

Covers SEC-005: what protects user-supplied provider keys at rest, where the key material lives,
and the exact procedure for rotating it without losing access to existing rows.

## What is encrypted

User-supplied provider API keys (BYOK), stored in `byok_keys.key_ciphertext`. They are encrypted
on write in `POST /api/keys` (BYOK path) and decrypted only in `src/providers/index.ts` when a call
is made on the user's behalf. Plaintext keys never enter `usage_events`, prompts, agent memory or
logs, and no endpoint returns a decrypted key to a caller.

## How

AES-256-GCM, key derived as `sha256(MASTER_KEY)`.

- A fresh 12-byte IV per record, from `crypto.randomBytes`.
- The 16-byte GCM auth tag is stored with the ciphertext, so tampering fails loudly instead of
  decrypting to garbage.
- Ciphertext format is `v1.<iv>.<tag>.<data>`, base64url. The `v1` prefix exists so the format can
  change later without guessing how to read old rows. Unprefixed three-part values are the original
  format and still decrypt.
- The same IV is never reused for a given key. Two encryptions of the same plaintext differ.

## Where the key lives

`MASTER_KEY` is an encrypted environment variable on the Vercel project, set for both production
and preview. It is not in the repository, not in `.env.production.local` on disk, and not in this
document. `MASTER_KEY` also authorises the `/api/admin/*` ops endpoints, so rotating it changes
admin access at the same time and the ops tooling must be updated in the same window.

`SESSION_SECRET` is separate and independent. Rotating `MASTER_KEY` does not log users out.

## Rotation procedure

The goal is to re-wrap every row under the new key with no downtime and no data loss.

1. Generate a new key: `openssl rand -hex 32`.
2. In Vercel, set `MASTER_KEY_PREVIOUS` to the current `MASTER_KEY` value, for production and
   preview. Do not touch `MASTER_KEY` yet.
3. Deploy. Nothing changes functionally: `decryptSecret` still reads everything with the current
   key, and the previous-key fallback is simply armed.
4. Set `MASTER_KEY` to the new value and deploy. From this point rows encrypted under the old key
   are still readable, because the fallback catches them, and `decryptSecretDetailed` reports
   `rotated: true` for those rows.
5. Re-wrap the rows. For each row, call `reencryptSecret(row.key_ciphertext)` and write
   `ciphertext` back over `key_ciphertext`. This is idempotent and safe to re-run; rows already
   under the new key report `rotated: false`.
6. Verify: no row remains that only decrypts with the old key. A count of rows where
   `decryptSecretDetailed` returns `rotated: true` should reach zero.
7. Remove `MASTER_KEY_PREVIOUS` and deploy. The old key is now useless, which is the point of
   rotating it.

Rotate immediately if the key was ever pasted into a chat, a ticket, a shell history or a log. A
rotation is not complete until step 7, because until then the old key still opens the remaining
rows.

## Failure modes

- **Auth tag mismatch** (`decryption_failed`): wrong key, tampered ciphertext, or a truncated
  value. The error is classified and does not echo the ciphertext or any partial plaintext.
- **Malformed payload** (`malformed_payload`): not the expected shape, including a `v1.` payload
  with the wrong number of parts.
- **Key lost with no previous key**: BYOK rows become unreadable and those users must re-enter
  their provider keys. Sessions, credits, balances and agents are unaffected, because none of them
  depend on `MASTER_KEY`. Keep a copy of the key in a password manager before ever deleting one.
- **Key present but `MASTER_KEY_PREVIOUS` still set after a completed rotation**: harmless, but it
  means an old key could still open rows, so finish step 7.

## Tests

`tests/byok-rotation.test.ts` covers the round trip, per-record IV uniqueness, tamper detection,
malformed-vs-wrong-key classification, legacy unprefixed payloads, previous-key fallback with
re-wrapping, and the locked state with no previous key configured.
