# Design notes & prior art

## The unmet need

Two people, each driving their own coding agent on a shared project, must keep their agents in sync. Today that means a human copy-pastes one agent's output into the other — one round trip per question, blocking whenever someone is away. Contexts are intentionally *different* (planner vs implementer); the goal is not to merge context but to **automate the relay** of the Q&A.

## Prior art (verified, 2026-06)

| Tool | Closest to us? | Why it falls short for this need |
| --- | --- | --- |
| `claude-code-session-bridge` (46★, MIT) | Mechanism match: two sessions, private context, Q&A relay, reads own files | **Same-machine only** (local-dir transport); async answer-on-behalf unwired; no auth; no turn cap; Claude-only (skill+slash-command). |
| CoAgent | MCP, cross-machine, 2-person | Not open source. |
| AgentPipe (137★, Go) | Cross-vendor "rooms" | Single-host / single-operator orientation. |
| claude-code-by-agents / Agentrooms (884★) | Cross-machine @mention rooms | Single-operator; Claude-centric Swift app. |
| A2A protocol (Linux Foundation, 150+ orgs) | Standardizes "agents as addressable principals" | A transport/identity standard, not a product; build **on** it, don't reinvent. |

**Conclusion:** build greenfield. Reuse the session-bridge *message contract*, *inbox/outbox mental model*, and *test scenarios* (MIT) as a spec and conformance corpus — not the code.

## Security lessons lifted from the session-bridge teardown

The teardown's vulns were rated low/info **only** under its "single-machine, trusted, same-UID" assumption. Magpie breaks that assumption (cross-machine, easy onboarding), so each becomes a real remote vector and must be designed out from the start:

- **Cross-session prompt injection** — peer content fed to an LLM told to *act* on it → fence as untrusted + action gate (`security.ts`).
- **Path traversal / `rm -rf` on unvalidated ids/pointers** → strict `EXTENSION_RE`, `assertSafeExtension`, no peer-derived destructive paths.
- **No auth / sender spoofing / no replay protection** → code-derived E2E channel binds identity; relay can't impersonate.
- **Unbounded message size** → `MAX_CONTENT_BYTES`.
- **No turn cap (`while true`)** → first-class call state machine + `maxTurns`.

The refuted-because-"trusted" pile from that audit is, in effect, Magpie's requirements list.
