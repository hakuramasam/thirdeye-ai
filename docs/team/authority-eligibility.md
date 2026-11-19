# ThirdEye Agent Authority Eligibility Matrix

**Policy version:** 1.0  
**Date:** 2026-11-19  
**Status:** Proposed and restrictive; does not modify live permissions.

| Agent | Read repository | Propose code/PR | Verify tests | Security review | Approve own work | Merge | Production deploy | Financial signing/movement |
|---|---|---|---|---|---|---|---|---|
| HERMES | Scoped | Coordinate only / delegated | No | No | No | No | No | No |
| PRODUCT | Scoped | Requirements/docs | No | No | No | No | No | No |
| ARCHITECT | Scoped | Design/owned paths | No | No | No | No | No | No |
| BACKEND | Scoped | Owned paths via PR | No | No | No | No | No | No |
| FRONTEND | Scoped | Owned paths via PR | No | No | No | No | No | No |
| BLOCKCHAIN | Scoped | Owned paths via PR | No | No | No | No | No | No |
| INTELLIGENCE | Scoped | Owned paths via PR | No | No | No | No | No | No |
| AGENT-ENGINEER | Scoped | Owned paths via PR | No | No | No | No | No | No |
| QA | Scoped | Test-only changes by policy | Yes, independent | No | No | No | No | No |
| SENTINEL | Scoped | Review comments/findings | Security verification | Yes, independent when not author | No | No | No | No |
| DEVOPS | Scoped | CI/docs/infrastructure PR | Deployment evidence only | No | No | No | No | No |
| DOCS | Scoped | Documentation PR | No | No | No | No | No | No |

## Non-delegable controls

1. Transaction authorization, identity/permissions, budget enforcement, audit integrity and production release remain code-enforced controls.
2. Human owner approval remains mandatory for production promotion, financial obligations, signer changes, treasury movement and other high-impact actions.
3. A separate HERMES GitHub identity may submit technical review only if its execution identity is isolated from authorship and the review is bound to the exact head SHA. A second username alone does not prove independence.
4. An agent review never substitutes for independent human financial/security acceptance.
5. No agent may change branch protection, rulesets, repository membership, secrets, billing limits or production environment protections.
6. No approval may be inferred from green CI, a skill score, role title, separate account or HERMES recommendation.

## Authority graduation is separate

Normal specialist competency graduation can authorize more reliable work within existing scoped tools. It does not grant repository write, merge, production or financial permissions. Any future authority proposal requires a separate threat model, negative tests, owner approval and enforcement verification.
