# Switchboard — TODO / Roadmap

Status snapshot (2026-06-25): core transport works and is validated live
cross-machine (iMac ↔ MacBook over LAN/Tailscale). 86 tests green. What remains
is mode ② (real agent autonomy) + UX + hardening + reach.

## ✅ Done
- Protocol/relay/client/MCP/CLI/auto-attendant(stub)/web(stub)/conformance scaffold.
- E2E AES-GCM channel from pairing code; relay brokers ciphertext only.
- Interactive CLI send; turn-cap notifies both sides; join-race channel fix.
- Provider-ToS compliance (`docs/COMPLIANCE.md`): auth separation, mode ③ excluded.
- **Resolution + report-on-termination**: `/resolve`, CALL REPORT, persisted to
  `~/.switchboard/calls/`, `history`/`report` recall. Verified live cross-machine.
- Proved a real `claude -p` agent can answer headlessly from its own files.

---

## P0 — Mode ② : real agent autonomy (the product)
- [ ] **Productize the real responder** in `@switchboard/auto-attendant` (not the
      demo `hostA.mjs`). Fix found live: spawn the agent CLI with **stdin closed**
      (`stdio: ['ignore','pipe','pipe']`), read-only tool scope
      (`--allowedTools LS Glob "Bash(ls:*)" Read`), `cwd` scoped to the project.
- [ ] **Tune the receiving-agent prompt for TRUSTED collaborators.** Live finding:
      the current "untrusted peer" fence is so strict the agent *refused a
      legitimate teammate question* (privacy). Need a "cooperative-but-bounded
      teammate" framing: answer the peer's questions about the shared work, still
      never execute arbitrary instructions / leak unrelated private data.
      (Trust dial: stranger ⟶ teammate.)
- [ ] **Persistent agent session** per side instead of fresh `claude -p` per turn
      (token efficiency; keeps conversation context across turns).
- [ ] **Auto-resolve**: the agent decides the matter is settled and calls resolve
      with a generated summary — currently a human types `/resolve`.
- [ ] **Terse, intent-tagged, reference-based** messages (not verbose NL);
      minimize the per-message fence overhead.

## P0 — Observability / waiting UX (user-flagged)
- [ ] **"Peer is thinking…" / progress signal** while waiting for the other agent.
      Today the asker sees nothing for ~30–60s (real model latency) → feels stuck.
      Need a status channel (e.g. a `status` message type or a typing indicator).
- [ ] **Live transcript "watch" view** — see both sides' messages + status in real
      time (also the trust/audit surface).

## P1 — CLI / usability
- [ ] Label your **own** sent messages (`› you:`) vs inbound (`📨`) — current bare
      terminal is confusing (hit live).
- [ ] Global `switchboard` command (`npm link` / install) instead of long
      `node packages/cli/dist/bin.js`.
- [ ] Pairing-code UX: 10-min TTL too short for human coordination; make TTL
      configurable + easy regenerate (hit live — codes kept expiring).
- [ ] Proper TUI (Claude-Code-like input box / panes). Wanted, lower priority.

## P1 — Routing / addressing (multi-agent: one person, many agents)
- [ ] Named-extension **directory + presence** so A can call `@b/risk` by name
      (relay registry lookup; no per-call code).
- [ ] Optional **receptionist agent** (`@b/desk`) for content-based dispatch to the
      right local agent.

## P2 — Reach (cover app-only users)
- [ ] **Remote HTTP/SSE MCP server** (Claude app / ChatGPT) + **BYO-key auth**
      (never users' subscription OAuth — see COMPLIANCE.md).
- [ ] **Web client `channel.open` crypto port** — browser join/watch with real
      decryption (currently a TODO stub, no fake decrypt).

## P2 — Security / ops hardening (before any public exposure)
- [ ] Relay **rate-limit + connection caps + access token**.
- [ ] **wss/TLS** deployment (Caddy auto-TLS) guide + make it the default for
      non-local relays (hides rendezvousId; see PROTOCOL.md §6a).
- [ ] **SPAKE2 PAKE** so short codes stay MITM-safe (currently HKDF-from-code).

## P3 — Robustness / cleanup
- [ ] cross-process `switchboard hangup` rejected as non-participant (minor;
      relies on SIGINT today).
- [ ] Reconnect / dropped-socket handling mid-call.
- [ ] Rename OS folder `agentmessenger` → `switchboard` (cosmetic; session cwd was
      pinned, so deferred).
