import { env } from '../lib/env.js'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_RE = /^[a-f0-9]{40}$/i
const REF_RE = /^(?:agent|work|feat|fix|chore|docs|test|ops)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/

export function validateCommitSha(value: unknown): string {
  const sha = String(value ?? '').trim()
  if (!SHA_RE.test(sha)) throw new Error('commit_sha must be a full 40-character Git commit SHA')
  return sha
}

export function validateCiRef(value: unknown): string {
  const ref = String(value ?? '').trim()
  if (!REF_RE.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.includes('//')) {
    throw new Error('ref must be a non-default review branch (agent/, work/, feat/, fix/, chore/, docs/, test/ or ops/)')
  }
  return ref
}

function githubConfig() {
  const token = env.githubToken
  const repo = env.githubRepo
  if (!token || !repo) throw new Error('GitHub operations are unavailable: repository token/name is not configured')
  if (!REPO_RE.test(repo)) throw new Error('Configured GitHub repository name is invalid')
  return { token, repo }
}

async function github(path: string, method = 'GET', body?: unknown) {
  const { token } = githubConfig()
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'thirdeye-agent-operations',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : {}
}

export const READ_CHECK_RUNS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_check_runs',
    description: 'Read GitHub Actions/check-suite results for one exact full commit SHA. Read-only; never changes PR or branch state.',
    parameters: { type: 'object', properties: { commit_sha: { type: 'string', description: 'Full 40-character commit SHA' } }, required: ['commit_sha'] },
  },
}

export const RUN_TEST_SUITE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'run_test_suite',
    description: 'Dispatch the repository CI workflow on a non-default review branch. Runs npm ci, skill validation, competency dry-run, typecheck, tests and credential scan. This does not merge or deploy. Requires GitHub Actions write scope.',
    parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Review branch only; main/master are forbidden' } }, required: ['ref'] },
  },
}

export const READ_DEPLOYMENT_STATUS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_deployment_status',
    description: 'Read status and source SHA for a known Vercel deployment ID. Read-only; cannot create, promote, cancel or roll back deployments.',
    parameters: { type: 'object', properties: { deployment_id: { type: 'string', description: 'Vercel deployment ID beginning dpl_' } }, required: ['deployment_id'] },
  },
}

export async function readCheckRuns(args: Record<string, unknown>): Promise<string> {
  const sha = validateCommitSha(args.commit_sha)
  const { repo } = githubConfig()
  const data = await github(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`)
  const checks = (data.check_runs ?? []).map((c: any) => ({
    name: c.name, status: c.status, conclusion: c.conclusion,
    started_at: c.started_at, completed_at: c.completed_at, html_url: c.html_url,
  }))
  return JSON.stringify({ commit_sha: sha, total_count: data.total_count ?? checks.length, checks })
}

export async function dispatchTestSuite(args: Record<string, unknown>): Promise<string> {
  const ref = validateCiRef(args.ref)
  const { repo } = githubConfig()
  await github(`/repos/${repo}/actions/workflows/ci.yml/dispatches`, 'POST', { ref })
  return JSON.stringify({ accepted: true, workflow: 'ci.yml', ref, note: 'Workflow dispatch accepted. Read check runs for the resulting commit SHA; dispatch acceptance is not a passing test result.' })
}

export async function readDeploymentStatus(args: Record<string, unknown>): Promise<string> {
  const deploymentId = String(args.deployment_id ?? '').trim()
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) throw new Error('deployment_id must be a Vercel dpl_ identifier; arbitrary URLs are not accepted')
  const token = process.env.VERCEL_TOKEN
  if (!token) throw new Error('Vercel status is unavailable: VERCEL_TOKEN is not configured')
  const teamId = process.env.VERCEL_TEAM_ID
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
  const response = await fetch(`https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}${query}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Vercel API ${response.status}: ${text.slice(0, 400)}`)
  const d = JSON.parse(text)
  return JSON.stringify({
    id: d.id, url: d.url, readyState: d.readyState ?? d.state, target: d.target ?? null,
    createdAt: d.createdAt, git: {
      branch: d.meta?.githubCommitRef ?? null,
      commit_sha: d.meta?.githubCommitSha ?? null,
      repository: d.meta?.githubRepo ?? null,
    },
    errorCode: d.errorCode ?? null, errorMessage: d.errorMessage ?? null,
  })
}

export function canRunCiForAgent(agentId: string): boolean {
  return ['tdt_hermes', 'tdt_qa', 'tdt_devops', 'tdt_agent-engineer'].includes(agentId)
}
