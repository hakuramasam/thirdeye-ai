# Approval policy

Human approval is required for anything that spends money or changes the world outside the
repository. The gate is enforced by the runtime; the policy here explains it.

## Always requires owner approval

| Action | Why |
|---|---|
| Broadcasting a mainnet transaction | Irreversible and costs real funds |
| Deploying a token contract | Irreversible, and public claims attach to it |
| Moving treasury or user funds | Someone else's money |
| Changing credit, pricing or payment logic | It decides what customers are charged |
| Rotating or adding production secrets | Access control |
| Raising an agent's budget or tool allowlist | Spend authority |
| Deleting data | Not recoverable |
| Publishing externally (X, docs site, partner channels) | The owner's voice and liability |

## Agent-level gates

- SENTINEL reports findings; it never fixes them. The fix is a separate reviewed task.
- A specialist cannot raise its own model tier or budget. It asks the orchestrator.
- The orchestrator cannot approve its own escalation. It asks the owner.
- QA cannot waive a failing test to let a release through.

## How approval is recorded

An approval is a row, not a chat message: who approved, what exactly, the task id, and an expiry.
A later change to the scope needs a new approval. Silence is never an approval, and neither is an
agent's own confidence that the change is safe.
