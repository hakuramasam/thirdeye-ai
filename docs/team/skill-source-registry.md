# ThirdEye Agent Skill & Knowledge Source Registry

**Reviewed:** 2026-11-19  
**Policy:** references are curated for reading; no third-party executable skill or script is copied or auto-run by WO-TEAM-01.

| Source | Official location | Best-fit roles | Use in ThirdEye | License/provenance handling |
|---|---|---|---|---|
| Agent Skills specification | https://agentskills.io/specification and https://github.com/agentskills/agentskills | AGENT-ENGINEER, all roles | Portable SKILL.md structure, metadata, progressive disclosure and validation conventions | Upstream repository reports Apache-2.0 code and CC-BY-4.0 documentation; verify individual files before copying |
| OWASP AI Agent & MCP Security | https://owasp.github.io/DevSecOpsGuideline/2-Process/2-2-Develop/2-2-5-AI-Agent-and-MCP-Security/ | SENTINEL, AGENT-ENGINEER, ARCHITECT, DEVOPS | Least agency, prompt injection, tool poisoning, untrusted content and MCP server vetting | Reference only; no text/code copied into runtime |
| OWASP Top 10 for Agentic Applications | https://genai.owasp.org/ | SENTINEL, AGENT-ENGINEER, ARCHITECT | Threat taxonomy and security review checklist | Reference only; verify current edition and attribution before reproducing material |
| Trail of Bits Skills | https://github.com/trailofbits/skills | SENTINEL, BLOCKCHAIN, QA, DEVOPS | Differential review, secure smart-contract workflow, supply-chain auditing, static analysis and fuzz testing | Repository and individual plugin licenses must be inspected before copying or executing any skill/script; reference only in this work order |
| Trail of Bits open-source security tools | https://trailofbits.com/tools | BLOCKCHAIN, SENTINEL, QA | Slither, Echidna, Medusa and related analysis tools as candidate tools for later evaluation | Tool-specific licenses, supported versions and CI resource costs must be checked before adoption |
| Playwright best practices | https://playwright.dev/docs/best-practices | FRONTEND, QA | User-visible assertions, test isolation, robust locators, CI traces and staging data isolation | Official documentation reference; do not add dependency without checking current package/version policy |
| OpenAI Codex skills | https://github.com/openai/skills | AGENT-ENGINEER, DOCS, all engineering roles | Examples and skill-authoring patterns for reusable workflows | Inspect per-directory license and dependencies before reuse; no code imported |
| GitHub Actions security hardening | https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions | DEVOPS, SENTINEL | Workflow token permissions, untrusted input, OIDC and supply-chain boundaries | Official documentation reference |
| PostgreSQL documentation | https://www.postgresql.org/docs/current/explicit-locking.html and https://www.postgresql.org/docs/current/transaction-iso.html | BACKEND, QA, ARCHITECT, BLOCKCHAIN | Row locks, deadlocks, isolation and transaction behavior | Official documentation reference; always match deployed PostgreSQL major version |
| Ethereum security guidance | https://ethereum.org/en/developers/docs/smart-contracts/security/ | BLOCKCHAIN, SENTINEL, QA | Smart-contract security fundamentals and review preparation | Official documentation reference; not a substitute for contract-specific audit |
| Solana security guidance | https://solana.com/docs/core/security | BLOCKCHAIN, SENTINEL, QA | Account validation, signer checks and program security | Official documentation reference; match current Solana runtime and SDK versions |

## Import gate

Before any third-party skill or executable is imported:
1. Pin repository URL, commit SHA, path and retrieval date.
2. Inspect license at repository and individual-file level; record SPDX identifier or mark `license-review-required`.
3. Review scripts, dependencies, install hooks, network access, file-system access and credential handling.
4. Run static scanning and tests in an isolated, disposable environment without production credentials.
5. Adapt content to ThirdEye role boundaries; do not inherit upstream permissions or tool grants.
6. Record maintainer, version, hash, approval and removal procedure.
7. Require SENTINEL review and owner approval for any tool that can write repositories, access credentials, move value or deploy.

## Current import status

No external executable skill, script, package or plugin was imported by WO-TEAM-01. These sources are registered as vetted reading candidates, not installed capabilities. ThirdEye's role packs remain project-authored and must be evaluated in the target runtime.
