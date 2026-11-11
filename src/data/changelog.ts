// Generated from the real commit history of the public repository.
// Regenerate with: git log --pretty=%H|%ad|%s --date=short | head -24
// Kept as data rather than read at runtime because the serverless runtime has no git.

export type ChangelogEntry = { sha: string; date: string; summary: string }

export const CHANGELOG: ChangelogEntry[] = [
  { sha: "d5fb69a", date: "2026-11-11", summary: "Settle a stream inside the response, so the true-up lands (#23)" },
  { sha: "c2349e4", date: "2026-11-11", summary: "Serve the market analyst as a scoped, capped Antseed relay (#22)" },
  { sha: "d267b8b", date: "2026-11-11", summary: "Store handoffs as addressable artifacts (#21)" },
  { sha: "f540da4", date: "2026-11-11", summary: "Enforce pipeline stage order with stage audit events (#19)" },
  { sha: "3f0bd10", date: "2026-11-11", summary: "Previews read a Neon branch, not live rows (#20)" },
  { sha: "734b329", date: "2026-11-11", summary: "Make a refused boot legible instead of a bare 500 (#18)" },
  { sha: "b80f641", date: "2026-11-11", summary: "Redemption rail: spend credits out to a token, settled only by a verified payout (#16)" },
  { sha: "9069a1b", date: "2026-11-11", summary: "Audit foundation: correlation ids, append-only event log, fail-closed handoffs (#17)" },
  { sha: "80827e4", date: "2026-11-10", summary: "chore: rebuild production to pick up new env vars" },
  { sha: "e1e0143", date: "2026-11-10", summary: "Deposits can go to a sponsored wallet (#15)" },
  { sha: "4d59c7f", date: "2026-11-10", summary: "Refund a stream overcharge to whoever paid it (#14)" },
  { sha: "32fcd53", date: "2026-11-10", summary: "Land the CI gate with a repo-scoped token that may create workflows" },
  { sha: "e8d7416", date: "2026-11-10", summary: "Check the status production actually writes" },
  { sha: "a5cc107", date: "2026-11-10", summary: "Catch the hallucinated date the first live run produced" },
  { sha: "e595175", date: "2026-11-10", summary: "Monitor the team's working log and hand real mismatches to HERMES" },
  { sha: "594034a", date: "2026-11-10", summary: "Declare agent pipelines, mapped from CI/CD practice" },
  { sha: "dcca66a", date: "2026-11-10", summary: "Give the team a write path, and make HERMES the decider inside a stated frame" },
  { sha: "fa6ac9c", date: "2026-11-10", summary: "Give the team a website-build workflow and encode the design system" },
  { sha: "d893d0e", date: "2026-11-10", summary: "Port the Lens & Frame design system into the dashboard and public pages" },
  { sha: "23c352e", date: "2026-11-10", summary: "Add the Paragraph API client and admin routes, reading the key from PARAGRAPH_API_KEY and exposing drafts but never publishing" },
  { sha: "df0a4c5", date: "2026-11-09", summary: "Merge the agent-facing API" },
  { sha: "0dba6c6", date: "2026-11-09", summary: "Add the agent-facing API and a public agent directory" },
  { sha: "d852249", date: "2026-11-09", summary: "Correct the published suite size to 219" },
  { sha: "077c39a", date: "2026-11-09", summary: "Merge the public site" },
]

// Build-time constant, updated per release: the runtime cannot count its own suite.
export const SUITE = { tests: 344, measuredOn: "2026-11-11", command: "npm test (PGlite, DATABASE_URL unset)" }
