# M/agent Arranger Skills v2

Seven arranger Skills designed for nested Skill delegation in M/agent.

- `song-arranger` is the top-level orchestrator.
- The other six are specialists and may delegate bounded subtasks.
- Nested calls are analysis/candidate generation only.
- The exact runtime `invoke_skill` schema is authoritative in M/agent.
