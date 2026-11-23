# Neon database branch lifecycle

This policy keeps production and persistent preview data out of automatic cleanup while placing a bounded retention window on disposable environments.

## Policy

| Branch class | Retention | Enforcement |
| --- | --- | --- |
| `main` | Permanent | Neon default branch; never assign an expiry |
| `vercel-preview` | Permanent | Explicitly excluded from the PR-close expiry workflow |
| Vercel-managed `preview/<github-branch>` | While PR is open, then 7 days after PR closure | `.github/workflows/neon-preview-branch-expiry.yml` |
| CI-only `ci/*` | 24 hours from creation | CI job must create the branch with Neon CLI `--expires-at` |

The expiry workflow handles same-repository pull requests only. It uses `pull_request_target` but checks out the trusted default branch, never the PR head, before loading the helper that receives `NEON_API_KEY`. It re-reads the PR state and checks for another open PR using the same branch before applying an expiry. Reopening a PR, reusing its branch in another open PR, or changing its head commit clears any scheduled expiry. The helper follows all Neon API pagination cursors, resolves the exact branch name, and refuses to modify default or protected branches.

If Vercel has already removed the Neon branch, the workflow reports that no action was needed. It never deletes a branch directly.

## Required GitHub configuration

Add the Neon API key as a repository Actions secret named `NEON_API_KEY`. The project ID is non-secret and is set in the workflow as `shiny-scene-69417365`.

The Neon MCP connection used by ChatGPT is not automatically available to GitHub Actions. Until this secret is configured, the expiry workflow deliberately fails with a clear error rather than silently pretending cleanup is active.

## CI-only branch creation

A CI job that genuinely needs an isolated Neon database must create a uniquely named branch and set its expiry at creation. Example for GitHub-hosted Ubuntu runners:

```bash
set -euo pipefail
: "${NEON_PROJECT_ID:?Set NEON_PROJECT_ID}"
: "${NEON_API_KEY:?Set NEON_API_KEY}"
branch="ci/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
expires_at="$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)"

npm exec --yes neon -- branches create \
  --project-id "$NEON_PROJECT_ID" \
  --name "$branch" \
  --parent main \
  --expires-at "$expires_at"
```

Do not create a Neon branch for the current PGlite-only CI suite unless a test specifically requires real PostgreSQL. If a future job creates one, it must use the `ci/*` namespace and the 24-hour expiry above.

## Safety rules

- Never assign an expiry to `main` or `vercel-preview`.
- Do not set TTLs on currently active preview branches retroactively.
- Do not run a scheduled blanket-delete job or infer that an old branch is unused from its age.
- Do not connect preview or CI branches to production secrets or production payment execution.
- Neon expiry permanently deletes the branch and its compute when the expiry is reached; use it only for disposable environments.
- Keep the existing Vercel preview database isolation workflow intact.

## Operational verification

After adding `NEON_API_KEY`, close a test PR and confirm the matching Neon branch reports an `expires_at` approximately seven days in the future. Reopen a disposable test PR and confirm its branch expiry is cleared. Also confirm `main` and `vercel-preview` still have no expiry. Do not use a production-data branch for this test.
