/**
 * Fail-closed SHA-bound independent review gate.
 *
 * An approval qualifies only when it is the reviewer's latest review, is APPROVED
 * on the PR's exact current head SHA, is not self-authored or bot-authored, and
 * GitHub independently confirms write, maintain, or admin repository permission.
 */
export function independentApprovalCandidates(reviews, headSha, authorLogin) {
  const latest = new Map()
  for (const review of reviews) {
    const login = review?.user?.login
    const submittedAt = review?.submitted_at
    if (!login || !submittedAt) continue
    const previous = latest.get(login)
    const time = Date.parse(submittedAt)
    const previousTime = previous ? Date.parse(previous.submitted_at) : -Infinity
    if (!previous || time > previousTime || (time === previousTime && Number(review.id) > Number(previous.id))) {
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

export function isWriteEligiblePermission(permission) {
  return ['write', 'maintain', 'admin'].includes(permission)
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const prNumber = process.env.PR_NUMBER
  const token = process.env.GITHUB_TOKEN
  if (!repo || !/^\\d+$/.test(prNumber || '') || !token) {
    throw new Error('GITHUB_REPOSITORY, PR_NUMBER and GITHUB_TOKEN are required')
  }

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  }
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers })
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`)
    return response.json()
  }

  const pr = await api(`/pulls/${prNumber}`)
  if (pr.draft) {
    console.log('SHA-bound review gate deferred: pull request is still a draft.')
    return
  }
  const headSha = pr.head?.sha
  const authorLogin = pr.user?.login
  if (!headSha || !authorLogin) throw new Error('Pull request head SHA or author is missing')

  const reviews = []
  for (let page = 1; ; page++) {
    const batch = await api(`/pulls/${prNumber}/reviews?per_page=100&page=${page}`)
    reviews.push(...batch)
    if (batch.length < 100) break
  }

  const candidates = independentApprovalCandidates(reviews, headSha, authorLogin)
  let acceptedReviewer
  for (const review of candidates) {
    try {
      const permission = await api(`/collaborators/${encodeURIComponent(review.user.login)}/permission`)
      if (isWriteEligiblePermission(permission.permission)) {
        acceptedReviewer = { login: review.user.login, permission: permission.permission }
        break
      }
    } catch {
      // Unknown or inaccessible permission is never sufficient authority.
    }
  }

  if (acceptedReviewer) {
    const currentPr = await api(`/pulls/${prNumber}`)
    if (currentPr.state !== 'open' || currentPr.head?.sha !== headSha) {
      console.error('PR head or state changed during review verification; re-run against the current open PR.')
      process.exitCode = 1
      return
    }
    console.log(`Independent approval verified for current head ${headSha.slice(0, 12)} by ${acceptedReviewer.login} (${acceptedReviewer.permission}).`)
    return
  }

  console.error(`No qualifying independent approval for current head ${headSha}. A non-author human reviewer must have their latest APPROVED review on this exact SHA and independently verified write, maintain, or admin permission.`)
  process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
