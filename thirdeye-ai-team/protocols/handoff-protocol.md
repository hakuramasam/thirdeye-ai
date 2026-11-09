# Handoff protocol

A handoff is a typed message, not a conversation. Both sides validate it against
`agent-message-schema.json`; an invalid message is refused before it reaches an agent.

## Required shape

```json
{
  "message_id": "uuid",
  "task_id": "task the message belongs to",
  "from_agent": "hermes",
  "to_agent": "backend",
  "message_type": "task_assignment",
  "created_at": "ISO-8601",
  "payload": { "instruction": "...", "acceptance_criteria": ["..."] },
  "requires_response": true
}
```

`message_type` is one of: `task_assignment`, `handoff`, `question`, `answer`, `blocker`,
`review_request`, `approval_request`, `status_update`, `cancel`. Anything else is malformed.

## The five rules

1. **Self-contained.** The receiver cannot see the sender's transcript. Repeat what they need.
2. **One outcome.** An instruction with two goals produces two tasks, not one ambiguous message.
3. **Acceptance criteria inside the message.** "Make it better" is a refusal.
4. **Evidence back, not narrative.** The reply carries the outcome, the evidence, the tests and
   the risks. The receiver reads what changed, not what was tried.
5. **Blockers are explicit.** A `blocker` message names the decision needed and who can make it.
   Silence is not a handoff.

## Refusal

Either side may refuse a message that is malformed, out of scope, or asks for a prohibited
action. A refusal quotes the rule it rests on and returns to the sender, who must rewrite it.
