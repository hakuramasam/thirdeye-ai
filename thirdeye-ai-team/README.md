# Thirdeye AI development team

Twelve agents with one orchestrator. Each agent is an independent package: a prompt
(`system.md`), a runtime contract (`agent.json`), a tool allowlist (`tools.json`) and its
responsibilities. Protocols are shared and validated in CI.

```
thirdeye-ai-team/
├── README.md
├── TEAM_ARCHITECTURE.md
├── AGENT_REGISTRY.json
├── orchestrator/          # HERMES: system.md, routing.md, workflow.md
├── agents/
│   └── <agent>/           # system.md, agent.json, responsibilities.md, tools.json
├── protocols/             # task, message and report schemas + handoff and approval policy
├── memory/                # namespace documentation (project, architecture, engineering, ...)
├── workflows/             # feature, bug, security, release, incident
├── templates/             # task, report, PR, milestone
└── scripts/validate-team.mjs
```

## Validate

```
node scripts/validate-team.mjs
```

Checks that every agent directory has the four required files, that `AGENT_REGISTRY.json` matches
the directories exactly, that every `agent.json` names a real tier and a positive budget, and that
the protocol schemas are valid JSON. CI runs the same script on every pull request.

## Non-negotiables

- No agent approves its own escalation, spend or production change.
- SENTINEL reports; a different task fixes.
- Money paths get a second reviewer.
- A claim about production is only made after running it in production.
