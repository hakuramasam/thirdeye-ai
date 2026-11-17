import test from 'node:test'
import assert from 'node:assert/strict'
import { latestIndependentApprovals } from '../.github/scripts/verify-hermes-phase-b-graduation.mjs'

const review = (id: number, login: string, state: string, sha: string, at: string, type = 'User') => ({
  id, user: { login, type }, author_association: 'COLLABORATOR', state, commit_id: sha, submitted_at: at,
})

test('graduation accepts only the latest independent human approval on the exact head', () => {
  const reviews = [
    review(1, 'reviewer', 'APPROVED', 'old', '2026-11-17T10:00:00Z'),
    review(2, 'reviewer', 'APPROVED', 'head', '2026-11-17T11:00:00Z'),
    review(3, 'author', 'APPROVED', 'head', '2026-11-17T12:00:00Z'),
    review(4, 'bot-reviewer', 'APPROVED', 'head', '2026-11-17T13:00:00Z', 'Bot'),
  ]
  assert.deepEqual(
    latestIndependentApprovals(reviews, 'head', 'author').map((x: { user: { login: string } }) => x.user.login),
    ['reviewer'],
  )
})

test('a newer non-approval supersedes an earlier approval', () => {
  const reviews = [
    review(1, 'reviewer', 'APPROVED', 'head', '2026-11-17T10:00:00Z'),
    review(2, 'reviewer', 'DISMISSED', 'head', '2026-11-17T11:00:00Z'),
  ]
  assert.deepEqual(latestIndependentApprovals(reviews, 'head', 'author'), [])
})


test('graduation rejects approvals from non-collaborator accounts', () => {
  const outsider = { ...review(5, 'outsider', 'APPROVED', 'head', '2026-11-17T14:00:00Z'), author_association: 'CONTRIBUTOR' }
  assert.deepEqual(latestIndependentApprovals([outsider], 'head', 'author'), [])
})
