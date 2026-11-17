type GraduationReview = {
  id: number
  user: { login: string; type?: string }
  state: string
  commit_id: string
  submitted_at: string
  author_association?: string
}
export function latestIndependentApprovals(
  reviews: GraduationReview[],
  headSha: string,
  authorLogin: string,
): GraduationReview[]
export function isWriteEligiblePermission(permission: string | undefined): boolean
export function collectActiveRulesetRequirements(rulesets: Array<{
  enforcement: string
  rules?: Array<{
    type: string
    parameters?: {
      required_approving_review_count?: number
      required_status_checks?: Array<{ context: string }>
      strict_required_status_checks_policy?: boolean
    }
  }>
}>): { contexts: string[]; strict: boolean; requiredApprovals: number }
