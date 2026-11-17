type ShaBoundReview = {
  id: number
  user: { login: string; type?: string }
  state: string
  commit_id: string
  submitted_at: string
}
export function independentApprovalCandidates(
  reviews: ShaBoundReview[],
  headSha: string,
  authorLogin: string,
): ShaBoundReview[]
export function isWriteEligiblePermission(permission: string | undefined): boolean
