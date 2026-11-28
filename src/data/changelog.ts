// Generated from the real commit history of the public repository.
// Regenerate with: git log --pretty=%H|%ad|%s --date=short | head -24
// Kept as data rather than read at runtime because the serverless runtime has no git.

export type ChangelogEntry = { sha: string; date: string; summary: string }

export const CHANGELOG: ChangelogEntry[] = [
  { sha: "b4445af", date: "2026-11-28", summary: "ci: defer Testcontainers Cloud until integration tests exist" },
  { sha: "979564e", date: "2026-11-28", summary: "ci: add optional Testcontainers Cloud setup" },
  { sha: "ce6214d", date: "2026-11-23", summary: "Serialize Neon preview lifecycle events for reused branches" },
  { sha: "1e671f3", date: "2026-11-23", summary: "Document safe Neon preview expiry and reopen behavior" },
  { sha: "fa10694", date: "2026-11-23", summary: "Handle Neon branch pagination and cancel expiry when PRs reopen" },
  { sha: "4678f10", date: "2026-11-23", summary: "Harden Neon branch lifecycle workflow against PR code execution" },
  { sha: "89e560e", date: "2026-11-23", summary: "Add Wrangler config required for Cloudflare Worker previews" },
  { sha: "1920c4f", date: "2026-11-23", summary: "Use documented Neon branch listing endpoint safely" },
  { sha: "999f4fe", date: "2026-11-23", summary: "Document Neon branch lifecycle and retention policy" },
  { sha: "5c1e832", date: "2026-11-23", summary: "Expire closed Neon preview branches after seven days" },
  { sha: "c20b09f", date: "2026-11-23", summary: "Add safe Neon preview branch expiry helper" },
  { sha: "34a0fb4", date: "2026-11-21", summary: "Add Virtual Protocol site verification meta tag" },
  { sha: "025ca53", date: "2026-11-20", summary: "fix: omit unsupported preview target in Vercel API request (#77)" },
  { sha: "658108d", date: "2026-11-19", summary: "feat(deps): check latest Node LTS patch and npm release" },
  { sha: "6c95607", date: "2026-11-11", summary: "Add claim.json with initial claim data" },
]

// Build-time constant, updated from the latest verified main CI run.
export const SUITE = { tests: 516, measuredOn: "2026-11-28", command: "npm test (PGlite, DATABASE_URL unset)" }
