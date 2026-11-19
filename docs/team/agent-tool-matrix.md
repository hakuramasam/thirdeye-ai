# ThirdEye agent tool access matrix

This matrix describes built-in runner tools. A tool appearing here is not a grant to merge,
deploy, approve financial work, sign transactions, or move funds.

| Tool | HERMES | PRODUCT | ARCHITECT | BACKEND | FRONTEND | BLOCKCHAIN | INTELLIGENCE | AGENT-ENGINEER | QA | SENTINEL | DEVOPS | DOCS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `read_artifact` | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| `repo_read` | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only | repo-read roster only |
| `repo_write` | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only | per-run grant only |
| `read_check_runs` | repo-read | repo-read | repo-read | repo-read | repo-read | repo-read | repo-read | repo-read | repo-read | repo-read | repo-read | repo-read |
| `run_test_suite` | yes | no | no | no | no | no | no | yes | yes | no | yes | no |
| `read_deployment_status` | VERCEL_TOKEN required | no | no | no | no | no | no | no | VERCEL_TOKEN required | no | VERCEL_TOKEN required | no |
| `open_pull_request` | via `repo_write` when per-run write granted | same | same | same | same | same | same | same | same | same | same | same |

## Enforcement notes

- Repository tools require the agent's existing repository-access setting. The role pack does not grant repo access.
- `run_test_suite` is restricted in code to HERMES, QA, DEVOPS and AGENT-ENGINEER, and accepts only non-default review branches. It dispatches `.github/workflows/ci.yml`; a dispatch acknowledgement is not a passing result.
- `read_check_runs` requires an exact 40-character commit SHA and is read-only.
- `read_deployment_status` is read-only, accepts a Vercel deployment ID (not an arbitrary URL), and is available only to HERMES, QA and DEVOPS when `VERCEL_TOKEN` is configured.
- `repo_write` creates an agent branch and opens a PR; it never merges. The existing money-path and credential guards remain in force.
- Tool calls are recorded through the existing run event/audit path. Skill version and SHA are stored at run level.
- No tool in this matrix can alter GitHub permissions, approve a financial operation, access a signer, move funds, merge a PR or promote a production deployment.
