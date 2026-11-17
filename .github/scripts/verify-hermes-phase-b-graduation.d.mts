type GraduationReview = {
  id: number
  user: { login: string; type?: string }
  state: string
  commit_id: string
  submitted_at: string
}
export function latestIndependentApprovals(
  reviews: GraduationReview[],
  headSha: string,
  authorLogin: string,
): GraduationReview[]
