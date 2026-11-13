/**
 * Read-only repository access for team agents.
 *
 * Scope is deliberately narrow: list a directory, read a file, search code. There is no
 * write operation here, and the tool refuses one if a model asks, because granting an
 * autonomous agent the ability to commit to the production repo is a separate decision
 * with its own review gate (see docs/repo-access.md).
 *
 * Secrets are never reachable through this tool: dotfiles, env files, key material and
 * .git internals are refused before any HTTP request is made.
 */

import { env } from '../lib/env.js'

export type RepoAccess = 'none' | 'read' | 'write'

/** True when this access level should receive the repo tool at all. */
export function hasRepoAccess(access?: string | null): boolean {
  return access === 'read' || access === 'write'
}

export const MAX_READ_CHARS = 20_000
const MAX_SEARCH_RESULTS = 20

/** Paths that must never be returned to a model, even if the token can read them. */
const DENIED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.agents\/\.env$/i,
  /(^|\/)secrets?\.(json|ya?ml|txt)$/i,
  /(^|\/)\.npmrc$/i,
]

export function isDeniedPath(path: string): boolean {
  const normalised = path.replace(/^\/+/, '')
  return DENIED_PATH_PATTERNS.some((re) => re.test(normalised))
}

/** Normalise a model-supplied path and refuse traversal or absolute escapes. */
export function normalisePath(raw: unknown): string {
  const p = String(raw ?? '').trim().replace(/^\.\//, '').replace(/^\/+/, '')
  if (p === '' || p === '.') return ''
  if (p.includes('..')) throw new Error('Path traversal is not allowed')
  if (p.includes('\0')) throw new Error('Invalid path')
  if (p.length > 400) throw new Error('Path is too long')
  return p
}

export const REPO_TOOL = {
  type: 'function' as const,
  function: {
    name: 'repo_read',
    description:
      'Read this project\'s own GitHub repository (read-only). Ops: "list" a directory, "read" a file, "search" the code. Use it to ground work in the real code instead of guessing. Write and commit are not available.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read', 'search'], description: 'Operation to perform' },
        path: { type: 'string', description: 'Repo-relative path for list or read, e.g. src/agents/runner.ts' },
        query: { type: 'string', description: 'Search text for op=search' },
        start_line: { type: 'number', description: 'First line to return for op=read (1-based, optional)' },
        end_line: { type: 'number', description: 'Last line to return for op=read (optional)' },
      },
      required: ['op'],
    },
  },
}

type RepoConfig = { token: string; repo: string; ref: string }

function config(override?: Partial<RepoConfig>): RepoConfig {
  return {
    token: override?.token ?? env.githubToken,
    repo: override?.repo ?? env.githubRepo,
    ref: override?.ref ?? env.githubRef,
  }
}

async function gh(cfg: RepoConfig, path: string): Promise<any> {
  if (!cfg.token) throw new Error('Repository access is not configured on this deployment (GITHUB_TOKEN missing)')
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'thirdeye-agent',
    },
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${String(body?.message || text).slice(0, 200)}`)
  }
  return body
}

function withLineNumbers(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(5)} | ${line}`)
    .join('\n')
}

/** Execute a repo tool call. Always returns a string for the model, never throws to the runner. */
export async function runRepoTool(args: Record<string, unknown>, override?: Partial<RepoConfig>): Promise<string> {
  const cfg = config(override)
  const op = String(args.op ?? '').trim()

  try {
    if (op === 'write' || op === 'commit' || op === 'edit') {
      return 'Refused: this agent has read-only repository access. Write access is not enabled for any agent yet.'
    }

    if (op === 'list') {
      const path = normalisePath(args.path)
      if (isDeniedPath(path || 'x')) return 'Refused: that path is not readable by agents.'
      const data = await gh(cfg, `/repos/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(cfg.ref)}`)
      if (Array.isArray(data)) {
        const lines = data
          .filter((d: any) => !isDeniedPath(String(d.path || '')))
          .sort((a: any, b: any) => (a.type === b.type ? String(a.name).localeCompare(String(b.name)) : a.type === 'dir' ? -1 : 1))
          .map((d: any) => `${d.type === 'dir' ? 'dir ' : 'file'}  ${d.path}${d.size ? `  (${d.size}b)` : ''}`)
        return `${cfg.repo}@${cfg.ref}:${path || '/'}\n${lines.join('\n') || '(empty directory)'}`
      }
      return `Not a directory. Use op=read for ${data?.path || path}`
    }

    if (op === 'read') {
      const path = normalisePath(args.path)
      if (!path) return 'Refused: path is required for op=read.'
      if (isDeniedPath(path)) return 'Refused: that path is not readable by agents (secret-shaped path).'
      const data = await gh(cfg, `/repos/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(cfg.ref)}`)
      if (Array.isArray(data)) return `${path} is a directory. Use op=list.`
      if (data?.encoding !== 'base64') return `Cannot read ${path}: unexpected encoding ${data?.encoding}`
      const text = Buffer.from(String(data.content || ''), 'base64').toString('utf8')
      const allLines = text.split('\n')
      const total = allLines.length
      const startRaw = Number(args.start_line)
      const endRaw = Number(args.end_line)
      const startLine = Number.isFinite(startRaw) && startRaw > 0 ? Math.min(Math.floor(startRaw), total) : 1
      const requestedEnd = Number.isFinite(endRaw) && endRaw >= startLine ? Math.floor(endRaw) : total

      // Trim to the character budget as well as the line window, so one huge file cannot
      // swallow the whole context window.
      let slice = allLines.slice(startLine - 1, requestedEnd)
      let body = withLineNumbers(slice.join('\n'), startLine)
      let truncated = false
      while (body.length > MAX_READ_CHARS && slice.length > 1) {
        slice = slice.slice(0, Math.max(1, Math.floor(slice.length / 2)))
        body = withLineNumbers(slice.join('\n'), startLine)
        truncated = true
      }
      const lastLine = startLine + slice.length - 1
      const footer = truncated || lastLine < total ? `\n\n[... truncated at line ${lastLine} of ${total}; request a range with start_line/end_line to continue]` : ''
      return `${cfg.repo}@${cfg.ref}:${path} (lines ${startLine}-${lastLine} of ${total})\n${body}${footer}`
    }

    if (op === 'search') {
      const q = String(args.query ?? '').trim()
      if (!q) return 'Refused: query is required for op=search.'
      if (q.length > 200) return 'Refused: query is too long.'
      const data = await gh(
        cfg,
        `/search/code?q=${encodeURIComponent(`${q} repo:${cfg.repo}`)}&per_page=${MAX_SEARCH_RESULTS}`
      )
      const items = (data?.items ?? []).filter((i: any) => !isDeniedPath(String(i.path || '')))
      if (!items.length) return `No matches for "${q}" in ${cfg.repo}.`
      return `${items.length} match(es) for "${q}" in ${cfg.repo}@${cfg.ref}:\n` +
        items.map((i: any) => `- ${i.path}`).join('\n')
    }

    return `Unknown op "${op}". Use list, read or search.`
  } catch (e: any) {
    return `repo_read failed: ${String(e?.message || e).slice(0, 300)}`
  }
}
