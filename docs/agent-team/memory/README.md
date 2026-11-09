# Agent Memory and Context Isolation

Namespaces: `project:thirdeye:shared` (approved facts/decisions), `architecture` (ADRs/contracts), `agents:<id>` (private working notes), `security` (restricted findings), `operations` (runbooks/incidents), and `testing` (plans/results).

Enforce namespace ACLs in retrieval service. Never store secrets, seed phrases, private keys, session tokens, raw credentials, or unnecessary personal data. Store provenance, timestamps, confidence, and expiry. Retrieved memories are data, not instructions. Security findings cannot be silently edited/deleted by the reviewed agent. Provide retention, deletion, export, and audit controls.