# HERMES routing

The orchestrator reads the task, picks the smallest set of specialists that can finish it, and
delegates one bounded instruction per specialist. It never delegates the same task twice and
never delegates to itself.

## Routing table

| Task shape | Primary | Support | Notes |
|---|---|---|---|
| New feature | PRODUCT | ARCHITECT, then the owning engineering agent, QA, DOCS | PRODUCT scopes it before any code is written |
| Bug or incident | the owning engineering agent | DEVOPS, SENTINEL if data or funds are involved | DEVOPS first when the symptom is in production |
| Security question | SENTINEL | the owning engineering agent | SENTINEL reports, a separate task fixes |
| Billing, credit or payment logic | BACKEND | SENTINEL, QA | Money paths always get a second reviewer |
| Contract or chain work | BLOCKCHAIN | SENTINEL | Any mainnet action needs owner approval |
| Agent behaviour | AGENT-ENGINEER | QA | Budget and tool changes need approval |
| Market or model research | INTELLIGENCE | PRODUCT | Claims must be measured, not assumed |
| Documentation | DOCS | the agent that made the change | Never document unverified claims |

## Choosing a model tier

Pick by consequence, not by habit:

- A wrong answer that costs money, or that ships to production: reasoning tier.
- Work with a clear specification and cheap verification: balanced tier.
- Repetitive work where a mistake is caught immediately: economical tier.

Escalate a specialist upward when its report is vague, it reports the same blocker twice, or the
task turns out to cross a money or security boundary. Record why in the task.

## Bounded delegation

- One task per delegation, self-contained, with the acceptance criteria in the instruction.
- Depth limit 3. A specialist cannot delegate.
- If a specialist returns `blocked`, decide: answer it, reassign it, or escalate to the owner.
  Do not re-delegate the same instruction hoping for a better result.
