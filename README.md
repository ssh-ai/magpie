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

## Quickstart (self-host)

No accounts, no hosted server — **you run everything**. One person runs a relay both agents can reach (same LAN/Tailscale, or a small cloud box); each person points their agent at it.

**1. Run a relay** (one person, on a reachable host):

```bash
# Docker (compiles the ~1 MB relay in-container):
docker build -t switchboard-relay rust/ && docker run -p 8787:8787 switchboard-relay

# …or straight from source (in ./rust):
cargo run --release -p switchboard-relay
# → [switchboard-relay] listening on ws://0.0.0.0:8787
```

It brokers **ciphertext only** — it never sees your code or messages. The reachable URL is `ws://<host>:8787` (put it behind a TLS reverse proxy for `wss://` on the public internet). For a trusted pair, running it on one laptop over Tailscale/LAN is enough.

**2. Add the Switchboard MCP to each agent** (both people), pointing at that relay:

```bash
# from source (today) — after `npm install && npx tsc -b`:
claude mcp add switchboard \
  -e SWITCHBOARD_RELAY_URL=ws://<relay-host>:8787 \
  -e SWITCHBOARD_EXTENSION=@you/role \
  -- node "$(pwd)/packages/mcp/dist/bin.js"

# planned one-liner (once published to npm):
# claude mcp add switchboard -e SWITCHBOARD_RELAY_URL=… -e SWITCHBOARD_EXTENSION=@you/role -- npx -y @switchboard/mcp
```

Codex / Antigravity: register the same command in their MCP config — the tools are identical.

**3. Just talk to your agent:**

```
You → agent:            "start a switchboard call about the agbot risk limit"
agent → you:            code K7F3-9M2P-XQ4R          # share with your partner over chat
partner → their agent:  "join K7F3-9M2P-XQ4R"
# the two agents exchange Q&A autonomously until they agree, then summarize to both of you.
```

Prefer a human at the keyboard instead of an agent? The `switchboard` CLI (Rust, single binary) does `start` / `join` interactively.

## Security model (summary)

- The **pairing code** is a one-time, short-lived shared secret. It derives an **AES-256-GCM end-to-end channel**; the relay brokers bytes it cannot read. (Upgrade path: SPAKE2 PAKE for shorter codes — see [`docs/PROTOCOL.md`](docs/PROTOCOL.md).)
- Every message is **schema-validated**; extensions (`@owner/role`) are strictly formatted, killing the id-spoofing / path-traversal class.
- Inbound peer content is **fenced as untrusted data**. A peer message may make your agent read its **own** files by default; running tools / editing requires your explicit approval (`runTools` gate).
- Calls have a **turn cap** and auto-terminate — no infinite agent ping-pong.

- Each agent runs on **its own owner's own authentication**; the relay never touches any provider token. Switchboard supports agent↔agent (each self-authenticated, cross-vendor) and you-talking-to-your-own-agent — it deliberately does **not** let one person drive another person's agent on the other's seat (a provider-ToS violation). See [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full handshake and threat model, [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) for the provider-terms constraints, and [`docs/DESIGN.md`](docs/DESIGN.md) for the prior-art analysis this is built on.

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

Working core, pre-release. MIT licensed. Agent↔agent calls (query → answer → mutual agreement → report) run cross-machine, end-to-end encrypted, over MCP. The relay/protocol/client/CLI have a **Rust implementation** (single static binaries; relay ~1 MB) alongside the TypeScript reference packages, verified byte-compatible on the wire and crypto. Not yet published to npm and not yet a public repo — **self-host from source** per the Quickstart above.
