import { appendFileSync, readFileSync } from 'node:fs'

export function latestIndependentApprovals(reviews, headSha, authorLogin) {
  const latest = new Map()
  for (const review of reviews) {
    const login = review?.user?.login
    if (!login || !review?.submitted_at) continue
    const previous = latest.get(login)
    const time = Date.parse(review.submitted_at)
    const oldTime = previous ? Date.parse(previous.submitted_at) : -Infinity
    if (!previous || time > oldTime || (time === oldTime && Number(review.id) > Number(previous.id))) {
      latest.set(login, review)
    }
  }
  return [...latest.values()].filter((review) =>
    review.state === 'APPROVED' &&
    review.commit_id === headSha &&
    review.user.login !== authorLogin &&
    review.user.type !== 'Bot'
  )
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')

  const manifest = JSON.parse(readFileSync('docs/authority/hermes-phase-b-graduation.json', 'utf8'))
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  }
  const request = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers })
    const body = await response.json().catch(() => ({}))
    return { status: response.status, body }
  }
  const api = async (path) => {
    const result = await request(path)
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`GitHub API ${result.status} for ${path}`)
    }
    return result.body
  }
  const paged = async (path) => {
    const all = []
    for (let page = 1; ; page++) {
      const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      all.push(...batch)
      if (batch.length < 100) return all
    }
  }
  const blockers = []
  const evidence = []
  const owner = (await api('')).owner?.login
  if (!owner) throw new Error('Repository owner could not be determined')

  for (const [gate, number] of Object.entries(manifest.required_pull_requests)) {
    const pr = await api(`/pulls/${number}`)
    if (!pr.merged || !pr.merged_at || !pr.merge_commit_sha) {
      blockers.push(`${gate}: PR #${number} is not merged`)
      evidence.push(`BLOCKED ${gate}: PR #${number} is open/unmerged`)
      continue
    }

    const reviews = await paged(`/pulls/${number}/reviews`)
    const approvals = latestIndependentApprovals(reviews, pr.head?.sha, pr.user?.login)
    const reviewers = []
    for (const review of approvals) {
      const permission = await request(`/collaborators/${encodeURIComponent(review.user.login)}/permission`)
      if (permission.status === 200 && ['write', 'maintain', 'admin'].includes(permission.body.permission)) {
        reviewers.push(review.user.login)
      }
    }
    const reviewGatePassed = reviewers.length >= manifest.minimum_independent_approvals
    if (!reviewGatePassed) {
      blockers.push(`${gate}: requires ${manifest.minimum_independent_approvals} latest independent approval(s) on exact head SHA ${pr.head?.sha}; found ${reviewers.length}`)
    }
    const checks = await api(`/commits/${pr.merge_commit_sha}/check-runs?per_page=100`)
    const successful = manifest.required_ci_check_names.every((name) =>
      checks.check_runs?.some((check) => check.name === name && check.conclusion === 'success')
    )
    if (!successful) blockers.push(`${gate}: required CI check(s) are not successful on merge commit ${pr.merge_commit_sha}`)

    evidence.push(`${reviewGatePassed && successful ? 'PASS' : 'BLOCKED'} ${gate}: merged PR #${number}; independent reviewers=${reviewers.join(', ') || 'missing'}; merge CI=${successful ? 'success' : 'not green'}`)
  }

  // A green workflow is not merge-blocking unless repository rules require it.
  // Read both classic branch protection and rulesets: repositories can use either or both.
  let contexts = []
  let strict = false
  const protection = await request('/branches/main/protection')
  if (protection.status === 200) {
    contexts.push(...(protection.body.required_status_checks?.contexts ?? []))
    strict ||= protection.body.required_status_checks?.strict === true
  } else if (protection.status !== 404) {
    blockers.push(`Unable to inspect main branch protection (HTTP ${protection.status})`)
  }

  const rulesetsResult = await request('/rulesets?includes_parents=true&per_page=100')
  if (rulesetsResult.status === 200 && Array.isArray(rulesetsResult.body)) {
    for (const ruleset of rulesetsResult.body.filter((r) => r.enforcement === 'active')) {
      for (const rule of ruleset.rules ?? []) {
        if (rule.type === 'required_status_checks') {
          contexts.push(...(rule.parameters?.required_status_checks ?? []).map((x) => x.context))
          strict ||= rule.parameters?.strict_required_status_checks_policy === true
        }
      }
    }
  } else {
    blockers.push(`Unable to inspect repository rulesets (HTTP ${rulesetsResult.status})`)
  }

  const hasCi = contexts.some((x) => ['verify', 'ci / verify'].includes(x))
  const hasReview = contexts.some((x) => manifest.required_branch_protection_contexts.slice(1).includes(x))
  if (!hasCi || !hasReview || !strict) {
    blockers.push(`main branch protection/rulesets must require current CI and SHA-bound review with strict up-to-date checks (found: ${contexts.join(', ') || 'none'})`)
  } else {
    evidence.push('PASS main branch rules require CI + SHA-bound independent review with strict up-to-date checks')
  }

  const attestation = process.env.OWNER_ATTESTATION || ''
  const actor = process.env.GITHUB_ACTOR || ''
  if (attestation && (attestation !== 'I_ACKNOWLEDGE_HERMES_PHASE_B_TECHNICAL_GATES' || actor !== owner)) {
    blockers.push('Owner attestation is invalid or was not dispatched by the repository owner')
  }

  const technicalPass = blockers.length === 0
  const status = technicalPass
    ? (attestation ? 'TECHNICAL_GATES_PASS_OWNER_ACKNOWLEDGED_NO_AUTHORITY_GRANTED' : 'TECHNICAL_GATES_PASS_OWNER_ATTESTATION_PENDING')
    : 'NOT_GRADUATED_BLOCKED'
  const lines = [
    `## ${manifest.stage} — automated graduation verification`,
    `**Result: ${status}**`,
    '',
    ...evidence.map((x) => `- ${x}`),
    ...(blockers.length ? ['', '### Blockers', ...blockers.map((x) => `- ${x}`)] : []),
    '',
    'This verifier checks technical prerequisites only. It never grants HERMES authority, merges PRs, deploys, or performs financial actions.',
  ]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
  if (blockers.length) process.exitCode = 1
}

if (process.argv[1]?.endsWith('verify-hermes-phase-b-graduation.mjs')) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
