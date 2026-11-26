/**
 * Role tools: the four verbs that let an agent verify its own work instead of asserting it.
 *
 * Every capability pack tells its owner to run the suite, read the CI result, open a pull
 * request and check the deployment, but the runner only exposed repo_read, repo_write,
 * delegate_to_agent, read_artifact and http_fetch. Without these four the instructions were
 * prose an agent could only describe:
 *
 *   run_tests          - run one test file or the suite, under a hard timeout
 *   read_check_runs    - GitHub check runs for one commit SHA
 *   open_pull_request  - open a PR from a branch that already exists; never merge
 *   read_deploy_status - the domains attached to a Vercel project
 *
 * Three rules hold for every tool here, enforced in code rather than asked for in a prompt:
 *
 *   1. Unknown arguments are refused, not ignored. A model that invents `merge: true` must be
 *      told no, not quietly granted a plain read.
 *   2. The result is a small typed object, never a raw upstream body or a header map, so a
 *      token has no path back to the model. Output is additionally redacted against the
 *      configured secrets as a second line of defence.
 *   3. Network and process access go through `RoleToolDeps`, so a test exercises every branch
 *      without a live GitHub, Vercel or child process.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

/** The suite gets three minutes; a run that needs longer is a run that should be split. */
export const DEFAULT_TEST_TIMEOUT_MS = 180_000
const MAX_OUTPUT_CHARS = 2000
const MAX_EXEC_BUFFER = 8 * 1024 * 1024
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number; shell: false; encoding: 'utf8' }
) => Promise<{ stdout: string; stderr: string }>

/**
 * Everything that touches the outside world is injected. Production passes nothing and the
 * defaults below are used; a test passes stubs and no packet leaves the process.
 */
export type RoleToolDeps = {
  exec?: ExecFileFn
  fetch?: typeof fetch
  githubToken?: string
  vercelToken?: string
  /** Repo root for `run_tests`. Defaults to the directory this module lives in, two up. */
  cwd?: string
  timeoutMs?: number
}

const defaultExec = promisify(execFile) as unknown as ExecFileFn

export type RoleToolName = 'run_tests' | 'read_check_runs' | 'open_pull_request' | 'read_deploy_status'

// ---------------------------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------------------------

function asRecord(tool: string, args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${tool} refused: arguments must be an object`)
  }
  return args as Record<string, unknown>
}

/**
 * Refuse an invented key rather than ignoring it. A silently dropped `merge: true` is worse
 * than an error: the model believes it asked for something and reads the plain result as
 * agreement.
 */
function assertKnownKeys(tool: string, args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`${tool} refused: unknown argument '${key}'`)
  }
}

function requireString(tool: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${tool} refused: '${field}' must be a non-empty string`)
  }
  return value.trim()
}

function secretsOf(deps: RoleToolDeps): string[] {
  return [deps.githubToken, deps.vercelToken, process.env.GITHUB_TOKEN, process.env.VERCEL_TOKEN].filter(
    (t): t is string => typeof t === 'string' && t.length >= 8
  )
}

/** Second line of defence: a secret that reaches any output is scrubbed before it is returned. */
function redact(text: string, deps: RoleToolDeps): string {
  let out = text
  for (const secret of secretsOf(deps)) out = out.split(secret).join('[redacted]')
  return out
}

function resolveFetch(deps: RoleToolDeps): typeof fetch {
  return deps.fetch ?? fetch
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'thirdeye-role-tools',
    authorization: `Bearer ${token}`,
  }
}

function githubTokenOf(deps: RoleToolDeps): string {
  const token = deps.githubToken ?? process.env.GITHUB_TOKEN ?? ''
  if (!token) throw new Error('GitHub token is not configured, so this tool cannot read or open anything')
  return token
}

// ---------------------------------------------------------------------------------------------
// run_tests
// ---------------------------------------------------------------------------------------------

export type RunTestsArgs = { files?: string[] }
export type RunTestsResult = { ok: boolean; pass: number; fail: number; output: string }

function tapCount(output: string, kind: 'pass' | 'fail'): number {
  const matches = output.matchAll(new RegExp(`^#\\s*${kind}\\s+(\\d+)\\s*$`, 'gm'))
  let total = 0
  for (const m of matches) total += Number(m[1])
  return total
}

/** A test path must be inside tests/ and must not climb out of it. */
function assertTestPath(path: string): string {
  const normalised = path.replace(/\\/g, '/')
  if (normalised.includes('..')) throw new Error(`runTests refused: '${path}' contains '..'`)
  if (!normalised.startsWith('tests/')) throw new Error(`runTests refused: '${path}' is not under tests/`)
  return normalised
}

/**
 * Run the suite (or the named files) and report the TAP summary. A red suite is a result, not
 * a throw: the agent needs the counts and the tail of the output to decide what to fix.
 */
export async function runTests(args: RunTestsArgs = {}, deps: RoleToolDeps = {}): Promise<RunTestsResult> {
  const input = asRecord('runTests', args)
  assertKnownKeys('runTests', input, ['files'])

  const rawFiles = input.files
  let files: string[] = []
  if (rawFiles !== undefined) {
    if (!Array.isArray(rawFiles)) throw new Error(`runTests refused: 'files' must be an array of test paths`)
    files = rawFiles.map((f) => assertTestPath(requireString('runTests', 'files', f)))
  }

  const exec = deps.exec ?? defaultExec
  const cwd = deps.cwd ?? REPO_ROOT
  const timeout = deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
  const argv = ['tsx', '--test', ...files]

  let stdout = ''
  let stderr = ''
  let exitCode = 0
  try {
    const result = await exec('npx', argv, {
      cwd,
      timeout,
      maxBuffer: MAX_EXEC_BUFFER,
      shell: false,
      encoding: 'utf8',
    })
    stdout = String(result?.stdout ?? '')
    stderr = String(result?.stderr ?? '')
  } catch (e: any) {
    // execFile rejects on a non-zero exit; the TAP summary is still on the error object.
    stdout = String(e?.stdout ?? '')
    stderr = String(e?.stderr ?? '')
    exitCode = typeof e?.code === 'number' ? e.code : 1
  }

  const combined = redact([stdout, stderr].filter(Boolean).join('\n'), deps)
  const pass = tapCount(combined, 'pass')
  const fail = tapCount(combined, 'fail')
  const parsed = /^#\s*(?:pass|fail)\s+\d+\s*$/m.test(combined)
  const ok = parsed && fail === 0 && exitCode === 0

  return { ok, pass, fail, output: combined.slice(-MAX_OUTPUT_CHARS) }
}

// ---------------------------------------------------------------------------------------------
// read_check_runs
// ---------------------------------------------------------------------------------------------

export type ReadCheckRunsArgs = { owner: string; repo: string; sha: string }
export type CheckRun = { name: string; status: string; conclusion: string | null }
export type ReadCheckRunsResult = { sha: string; checks: CheckRun[]; allGreen: boolean }

export async function readCheckRuns(
  args: ReadCheckRunsArgs,
  deps: RoleToolDeps = {}
): Promise<ReadCheckRunsResult> {
  const input = asRecord('readCheckRuns', args)
  assertKnownKeys('readCheckRuns', input, ['owner', 'repo', 'sha'])
  const owner = requireString('readCheckRuns', 'owner', input.owner)
  const repo = requireString('readCheckRuns', 'repo', input.repo)
  const sha = requireString('readCheckRuns', 'sha', input.sha)

  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`readCheckRuns refused: '${sha}' is not a 40-character hex commit sha`)
  }

  const token = githubTokenOf(deps)
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`
  const res = await resolveFetch(deps)(url, { method: 'GET', headers: githubHeaders(token) })
  if (!res.ok) throw new Error(`readCheckRuns failed: GitHub returned HTTP ${res.status}`)

  const body: any = await res.json()
  const checks: CheckRun[] = (Array.isArray(body?.check_runs) ? body.check_runs : []).map((run: any) => ({
    name: String(run?.name ?? ''),
    status: String(run?.status ?? ''),
    conclusion: run?.conclusion == null ? null : String(run.conclusion),
  }))

  // No checks is not green: nothing has verified the commit yet.
  const allGreen = checks.length > 0 && checks.every((c) => c.status === 'completed' && c.conclusion === 'success')
  return { sha, checks, allGreen }
}

// ---------------------------------------------------------------------------------------------
// open_pull_request
// ---------------------------------------------------------------------------------------------

export type OpenPullRequestArgs = { owner: string; repo: string; head: string; base: string; title: string; body?: string }
export type OpenPullRequestResult = { number: number; url: string; draft: boolean }

export async function openPullRequest(
  args: OpenPullRequestArgs,
  deps: RoleToolDeps = {}
): Promise<OpenPullRequestResult> {
  const input = asRecord('openPullRequest', args)
  assertKnownKeys('openPullRequest', input, ['owner', 'repo', 'head', 'base', 'title', 'body'])
  const owner = requireString('openPullRequest', 'owner', input.owner)
  const repo = requireString('openPullRequest', 'repo', input.repo)
  const head = requireString('openPullRequest', 'head', input.head)
  const base = requireString('openPullRequest', 'base', input.base)
  const title = requireString('openPullRequest', 'title', input.title)
  const body = input.body === undefined ? '' : String(input.body)

  if (head === base) {
    throw new Error(`openPullRequest refused: head and base are both '${base}', which would open an empty pull request`)
  }

  const token = githubTokenOf(deps)
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`
  const res = await resolveFetch(deps)(url, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ title, head, base, body }),
  })
  if (!res.ok) throw new Error(`openPullRequest failed: GitHub returned HTTP ${res.status}`)

  const created: any = await res.json()
  return {
    number: Number(created?.number),
    url: String(created?.html_url ?? created?.url ?? ''),
    draft: Boolean(created?.draft),
  }
}

// ---------------------------------------------------------------------------------------------
// read_deploy_status
// ---------------------------------------------------------------------------------------------

export type ReadDeployStatusArgs = { project: string }
export type DeployDomain = { name: string; verified: boolean }
export type ReadDeployStatusResult = { project: string; domains: DeployDomain[] }

export async function readDeployStatus(
  args: ReadDeployStatusArgs,
  deps: RoleToolDeps = {}
): Promise<ReadDeployStatusResult> {
  const input = asRecord('readDeployStatus', args)
  assertKnownKeys('readDeployStatus', input, ['project'])
  const project = requireString('readDeployStatus', 'project', input.project)

  const token = deps.vercelToken ?? process.env.VERCEL_TOKEN ?? ''
  if (!token) throw new Error('Vercel token is not configured, so this tool cannot read deploy status')

  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}/domains`
  const res = await resolveFetch(deps)(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'thirdeye-role-tools',
    },
  })
  if (!res.ok) throw new Error(`readDeployStatus failed: Vercel returned HTTP ${res.status}`)

  const body: any = await res.json()
  const domains: DeployDomain[] = (Array.isArray(body?.domains) ? body.domains : []).map((d: any) => ({
    name: String(d?.name ?? ''),
    verified: Boolean(d?.verified),
  }))

  return { project, domains }
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export type RoleToolDefinition = {
  name: RoleToolName
  description: string
  /** True only for the one tool that creates something on a remote service. */
  requiresWrite: boolean
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
  handler: (args: any, deps?: RoleToolDeps) => Promise<unknown>
}

/**
 * The registry a runner consumes. Names are the model-facing names, so a tool list can be
 * built straight from this array without a second mapping table to drift out of date.
 */
export const ROLE_TOOLS: readonly RoleToolDefinition[] = [
  {
    name: 'run_tests',
    description:
      'Run the test suite, or specific files under tests/, and return the pass/fail counts plus the tail of the output. Use it to check your own change before claiming it works.',
    requiresWrite: false,
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test paths relative to the repo root, each under tests/. Omit to run the whole suite.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: runTests,
  },
  {
    name: 'read_check_runs',
    description:
      'Read the GitHub check runs for one commit SHA. Returns each check name, status and conclusion, and whether every check is green. Use it instead of assuming CI passed.',
    requiresWrite: false,
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner, e.g. hakuramasam' },
        repo: { type: 'string', description: 'Repository name, e.g. thirdeye-ai' },
        sha: { type: 'string', description: 'Full 40-character commit SHA' },
      },
      required: ['owner', 'repo', 'sha'],
      additionalProperties: false,
    },
    handler: readCheckRuns,
  },
  {
    name: 'open_pull_request',
    description:
      'Open a pull request from an existing branch into a base branch. Returns its number and URL. It never merges: a human reviews and merges.',
    requiresWrite: true,
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        head: { type: 'string', description: 'Source branch that already exists' },
        base: { type: 'string', description: 'Target branch, usually main' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request description' },
      },
      required: ['owner', 'repo', 'head', 'base', 'title'],
      additionalProperties: false,
    },
    handler: openPullRequest,
  },
  {
    name: 'read_deploy_status',
    description:
      'Read the domains attached to a Vercel project and whether each is verified. Use it to check a deployment actually exists instead of asserting it does.',
    requiresWrite: false,
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Vercel project name or id' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: readDeployStatus,
  },
]

export const ROLE_TOOL_NAMES: readonly RoleToolName[] = ROLE_TOOLS.map((t) => t.name)

export function isRoleToolName(name: string): name is RoleToolName {
  return ROLE_TOOLS.some((t) => t.name === name)
}

/** Dispatch by model-facing name, for a runner that already holds the parsed arguments. */
export async function runRoleTool(name: RoleToolName, args: unknown, deps: RoleToolDeps = {}): Promise<unknown> {
  const tool = ROLE_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`Unknown role tool: ${name}`)
  return tool.handler(args, deps)
}
