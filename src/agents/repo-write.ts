/**
 * Repository write access for team agents: branch and pull request only, never main.
 *
 * Three decisions are enforced here rather than asked for in a prompt, because a model that
 * ignores advice must still be unable to do damage:
 *   1. The base branch is always the default branch and the write always lands on a new
 *      `agent/`-prefixed branch. There is no code path that commits to main.
 *   2. A merge is never performed. The tool opens a pull request and stops. A human or a
 *      green CI run decides what happens next.
 *   3. Paths are allowlisted to source, web, tests, docs, team and CI config. Money paths
 *      (src/payments, src/lib/billing|settle|profit|reconcile|keycredit) are refused outright
 *      even inside the allowlist, because those need a named human's signature.
 *
 * Every write is capped in file count and bytes, and content is scanned for credential-shaped
 * strings before it leaves the process. A refusal returns an instruction, not an exception, so
 * the agent can correct itself instead of retrying blindly.
 */

import { env } from '../lib/env.js'

export const WRITE_MAX_FILES = 12
export const WRITE_MAX_BYTES = 200_000

/** Directories an agent may touch. Everything else is refused. */
const ALLOWED_PREFIXES = ['src/', 'web/', 'tests/', 'docs/', 'team/', '.github/']

/** Within the allowlist, these still require a human because they move money or keys. */
const MONEY_PATHS = [
  /^src\/payments\//,
  /^src\/lib\/(billing|settle|reconcile|profit|keycredit|keybudget|creditPolicy)\.ts$/,
  /^src\/lib\/keys\.ts$/,
  /^src\/db\/schema\.sql$/,
]

const DENIED = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
]

export function validateWritePath(raw: unknown): string {
  const p = String(raw ?? '').trim().replace(/^\.\//, '').replace(/^\/+/, '')
  if (!p) throw new Error('An empty path is not writable')
  if (p.includes('..')) throw new Error('Path traversal is not allowed')
  if (p.includes('\0') || p.length > 300) throw new Error('Invalid path')
  if (DENIED.some((re) => re.test(p))) throw new Error(`Refusing to write ${p}: credentials and internals are off limits`)
  if (!ALLOWED_PREFIXES.some((pre) => p.startsWith(pre))) {
    throw new Error(`Refusing to write ${p}: only ${ALLOWED_PREFIXES.join(', ')} are writable`)
  }
  if (MONEY_PATHS.some((re) => re.test(p))) {
    throw new Error(`Refusing to write ${p}: money and key paths need a named human's signature, not an agent's`)
  }
  return p
}

export function validateBranchName(raw: unknown): string {
  let b = String(raw ?? '').trim()
  if (!b) b = 'agent/unnamed'
  if (!b.startsWith('agent/')) b = `agent/${b}`
  if (!/^agent\/[a-z0-9][a-z0-9._-]{1,80}$/i.test(b)) {
    throw new Error('Branch must look like agent/<slug> using letters, digits, dot, dash or underscore')
  }
  if (/^agent\/(main|master)$/i.test(b)) throw new Error('Never write to the default branch')
  return b
}

/** Returns the name of the matched pattern when content looks like a credential, else null. */
export function detectSecret(content: string): string | null {
  const checks: Array<[string, RegExp]> = [
    // Most specific first: our own key shape would otherwise be reported as a generic OpenAI key.
    ['our api key', /sk-thirdeye-[A-Za-z0-9]{8,}/],
    ['openai-style key', /sk-(proj-|ant-)[A-Za-z0-9_-]{20,}/],
    ['aws access key', /AKIA[0-9A-Z]{16}/],
    ['private key block', /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/],
    ['github token', /gh[pousr]_[A-Za-z0-9]{20,}/],
    ['long hex secret', /\b[a-f0-9]{64}\b/i],
  ]
  for (const [name, re] of checks) if (re.test(content)) return name
  return null
}

export function validateWriteBatch(files: Array<{ path?: unknown; content?: unknown }>): Array<{ path: string; content: string }> {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Pass at least one file')
  if (files.length > WRITE_MAX_FILES) throw new Error(`Too many files: ${files.length} exceeds ${WRITE_MAX_FILES}`)
  let total = 0
  const out = files.map((f) => {
    const path = validateWritePath(f?.path)
    const content = String(f?.content ?? '')
    total += Buffer.byteLength(content, 'utf8')
    const secret = detectSecret(content)
    if (secret) throw new Error(`Refusing to commit ${path}: looks like it contains a ${secret}`)
    return { path, content }
  })
  if (total > WRITE_MAX_BYTES) throw new Error(`Content too large: ${total} bytes exceeds ${WRITE_MAX_BYTES}`)
  return out
}

export const REPO_WRITE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'repo_write',
    description:
      'Propose a change to this project by opening a pull request. You cannot commit to main and cannot merge: the tool creates an agent/<branch>, commits your files, and opens a PR. Writable: src/, web/, tests/, docs/, team/, .github/. Refused: money and billing paths, keys, schema.sql, env files. Include the verification you expect CI to prove in the PR body.',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Short slug; stored as agent/<slug>' },
        title: { type: 'string', description: 'PR title, under 80 characters' },
        body: { type: 'string', description: 'What changed, why, and how it should be verified' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
      required: ['branch', 'title', 'body', 'files'],
    },
  },
}

type Cfg = { token?: string; repo?: string; base?: string }

async function gh(path: string, init: RequestInit & { token: string }) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${init.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'thirdeye-agent',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 240)}`)
  return text ? JSON.parse(text) : {}
}

export async function runRepoWrite(args: Record<string, any>, override: Cfg = {}): Promise<string> {
  const token = override.token ?? env.githubToken
  const repo = override.repo ?? env.githubRepo
  const base = override.base ?? env.githubRef ?? 'main'
  if (!token || !repo) return 'repo_write is unavailable: the repository token or name is not configured.'

  let files: Array<{ path: string; content: string }>
  let branch: string
  try {
    files = validateWriteBatch(args?.files)
    branch = validateBranchName(args?.branch)
  } catch (e: any) {
    return `repo_write refused: ${String(e?.message || e).slice(0, 300)}`
  }

  const title = String(args?.title ?? 'Agent proposal').slice(0, 80)
  const body = String(args?.body ?? '').slice(0, 8000)

  try {
    const ref = await gh(`/repos/${repo}/git/ref/heads/${base}`, { method: 'GET', token })
    const sha = ref?.object?.sha
    if (!sha) return 'repo_write failed: could not resolve the base branch.'
    await gh(`/repos/${repo}/git/refs`, {
      method: 'POST',
      token,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    })
    for (const f of files) {
      await gh(`/repos/${repo}/contents/${encodeURI(f.path)}`, {
        method: 'PUT',
        token,
        body: JSON.stringify({
          message: `${title}\n\n${f.path}`.slice(0, 500),
          content: Buffer.from(f.content, 'utf8').toString('base64'),
          branch,
        }),
      })
    }
    const pr = await gh(`/repos/${repo}/pulls`, {
      method: 'POST',
      token,
      body: JSON.stringify({ title, head: branch, base, body }),
    })
    return `Pull request opened: ${pr?.html_url} on branch ${branch} (${files.length} file(s)). It is not merged: CI and a human decide that.`
  } catch (e: any) {
    return `repo_write failed: ${String(e?.message || e).slice(0, 300)}`
  }
}
