import test from 'node:test'
import assert from 'node:assert/strict'
import { independentApprovalCandidates } from '../.github/scripts/verify-sha-bound-review.mjs'

const review = (id: number, user: string, state: string, sha: string, submittedAt: string) => ({
  id,
  user: { login: user },
  state,
  commit_id: sha,
  submitted_at: submittedAt,
})

test('only the latest review by a non-author on the exact current head qualifies', () => {
  const reviews = [
    review(1, 'reviewer', 'APPROVED', 'old-sha', '2026-11-17T10:00:00Z'),
    review(2, 'reviewer', 'APPROVED', 'current-sha', '2026-11-17T11:00:00Z'),
    review(3, 'author', 'APPROVED', 'current-sha', '2026-11-17T12:00:00Z'),
    review(4, 'stale-reviewer', 'APPROVED', 'old-sha', '2026-11-17T13:00:00Z'),
  ]
  assert.deepEqual(
    independentApprovalCandidates(reviews, 'current-sha', 'author').map((r: { user: { login: string } }) => r.user.login),
    ['reviewer'],
  )
})

test('a later comment or changes-requested review invalidates an earlier approval', () => {
  const reviews = [
    review(1, 'reviewer', 'APPROVED', 'current-sha', '2026-11-17T10:00:00Z'),
    review(2, 'reviewer', 'COMMENTED', 'current-sha', '2026-11-17T11:00:00Z'),
    review(3, 'other', 'APPROVED', 'current-sha', '2026-11-17T12:00:00Z'),
    review(4, 'other', 'CHANGES_REQUESTED', 'current-sha', '2026-11-17T13:00:00Z'),
  ]
  assert.deepEqual(independentApprovalCandidates(reviews, 'current-sha', 'author'), [])
})

test('an approval on an older head cannot approve a later push', () => {
  const reviews = [review(1, 'reviewer', 'APPROVED', 'sha-before-push', '2026-11-17T10:00:00Z')]
  assert.deepEqual(independentApprovalCandidates(reviews, 'sha-after-push', 'author'), [])
})
