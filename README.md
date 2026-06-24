# Switchboard

**A switchboard for AI agents.** Patch one person's agent through to another's. They talk; you stay on the line.

When two people collaborate and each drives their own coding agent (Claude, Codex, Gemini, …), keeping them in sync means copy-pasting between agents — one round trip per question, and it stalls the moment someone steps away. Switchboard replaces the human relay with a direct, secure line between the two agents. Each agent keeps its **own private context** and reads its **own files**; only the Q&A crosses.

> Think of it as a phone switchboard: every agent gets an **extension**, you **patch** two through, and they're on a **call**. An **auto-attendant** can answer on your behalf when you're away.

## Why it's different

The agent-to-agent messaging space exists (session-bridge, AgentPipe, A2A, …) but every option is one of: same-machine-only, single-operator, Claude-only, or developer-CLI-only. Switchboard targets the unmet combination:

- **Cross-vendor** — Claude↔Claude, GPT↔GPT, or any mix, via one MCP adapter.
- **Cross-machine** — two people on two laptops, brokered by a relay (not a shared filesystem).
- **Async / answer-on-behalf** — your agent answers within its domain while you're away; escalates to you when unsure.
- **Dead-simple onboarding** — no accounts, no key files. One command + a short code, like a Zoom invite.
- **Secure by construction** — end-to-end encrypted channel from the pairing code; inbound peer text is treated as untrusted data, never executed without your approval.

## How a call works

```
A's agent:  switchboard start "is agbot's risk limit implemented correctly?"
            → code: K7F3-9M2P-XQ4R   (share this with B over chat)

B's agent:  switchboard join K7F3-9M2P-XQ4R
            → patched through.

… the two agents exchange queries/answers autonomously, each reading its own
   files, until they converge or hit the turn cap, then auto-hang-up and
   summarize to both humans.
```

One handshake, then unlimited automatic round trips — strictly cheaper than relaying by hand.

## Security model (summary)

- The **pairing code** is a one-time, short-lived shared secret. It derives an **AES-256-GCM end-to-end channel**; the relay brokers bytes it cannot read. (Upgrade path: SPAKE2 PAKE for shorter codes — see [`docs/PROTOCOL.md`](docs/PROTOCOL.md).)
- Every message is **schema-validated**; extensions (`@owner/role`) are strictly formatted, killing the id-spoofing / path-traversal class.
- Inbound peer content is **fenced as untrusted data**. A peer message may make your agent read its **own** files by default; running tools / editing requires your explicit approval (`runTools` gate).
- Calls have a **turn cap** and auto-terminate — no infinite agent ping-pong.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full handshake and threat model, and [`docs/DESIGN.md`](docs/DESIGN.md) for the prior-art analysis this is built on.

## Packages

| Package | Role |
| --- | --- |
| `@switchboard/protocol` | Shared contract: message schema, pairing/handshake, security primitives. |
| `@switchboard/relay` | The switchboard: WebSocket rendezvous + call/extension registry + turn-cap enforcement. Brokers ciphertext only. |
| `@switchboard/mcp` | MCP server so **any** MCP-capable agent (Claude Code, Codex, Gemini CLI, …) gets `start`/`join`/`ask`/`listen` tools. |
| `@switchboard/cli` | `switchboard start｜join｜call｜listen｜hangup`. |
| `@switchboard/auto-attendant` | Vendor-pluggable headless responder that answers on your behalf (claude / codex / gemini adapters) and escalates when unsure. |
| `conformance/` | Behavioral tests, including the ported session-bridge scenario corpus. |

## Status

Early scaffold. MIT licensed.
