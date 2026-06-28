# Switchboard — TODO / Roadmap

Status snapshot (2026-06-25): core transport works and is validated live
cross-machine (iMac ↔ MacBook over LAN/Tailscale). 86 tests green. What remains
is mode ② (real agent autonomy) + UX + hardening + reach.

## Scope decisions (2026-06-25, situation-driven)
- **THE core (S2):** two agents talk DIRECTLY, multi-turn, until **mutual
  agreement** — then report to both humans. One-shot Q&A is NOT the product
  (you wouldn't need this for that). Origin: A plans / B implements; A thinks it's
  wrong → repeated human-relayed back-and-forth until it's right → that repetition
  is the pain. Stop condition = "nothing left to resolve / agreed", with the turn
  cap only as a safety backstop. **This is the main thing still missing** (we have
  the answerer side; we lack the autonomous driver that evaluates the peer's reply
  against its own spec, pushes back, and declares agreement).
- Both sides are LIVE/present (see S3 below), so this runs over live sessions (MCP).
- **S5 (app users) is IN scope** — needs a remote HTTP MCP server (BYO-key).
- **S3 (answer-while-away from saved files): DEFERRED by decision.** Felt wrong —
  connection should require the other person to actually be working/present. So
  drop the "files-if-off" fallback for now (the live-or-files switch we built stays,
  but the file fallback is optional). Revisit later if a real need appears.
- **S6 (non-dev web watch/approve): OUT for now** — target is developers; app
  users (S5) cover participation.
- S4 (Codex/Gemini) later; S8 hard sandbox later; S9 works (harden only on public
  exposure).

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
- [x] **THE core: autonomous agree-loop (S2).** `AutoDriver` (drives a goal:
      ask → evaluate peer reply vs its OWN spec/files → push back → conclude) +
      `ClaudeDriver`, paired with the existing `AutoAttendant`/`ClaudeResponder`.
      Two real claude agents converse multi-turn, no human typing, and reach a
      firm AGREE conclusion (pass OR fail) with evidence, then resolve+report.
      ✅ verified live (spec 2%+max-3 vs impl → agreed "MET" with file:line evidence).
      Fixes found live: AGREE = "conclusion reached (pass/fail)" not "passed" (or it
      loops); responder must enumerate files before claiming absence (false-negative).
  - [ ] v1.1: mutual confirm (B also agrees before close) + no-progress escalate.
- [x] **Real responder productized** in `@switchboard/auto-attendant`:
      `ClaudeResponder` runs the official CLI with stdin closed + read-only tools
      (`--allowedTools LS Glob Grep Read "Bash(ls:*)"`), `cwd`-scoped; added a
      `switchboard-attend <code>` bin. ✅ verified live: a real claude attendant
      answered an asker's project question over the relay (E2E, no refusal).
- [x] **Receiving-agent prompt tuned for TRUSTED collaborators** — "cooperative
      teammate" framing replaces the over-strict fence that made the agent refuse
      a legitimate teammate question. (Still: never executes embedded instructions,
      read-only, cwd-scoped, fail-closed CONFIDENCE.) ✅
- [x] **Out-of-scope / low-confidence no longer kills the call.** The attendant
      now DECLINES in-band ("⚠️ I can't answer that — outside my project scope; I've
      flagged it for my operator") and STAYS on the line; only the turn cap / an
      explicit hangup ends a call. ✅ verified live (in-scope → real answer;
      `~/Desktop` → polite decline, call stayed alive).
- [~] **Hybrid live-or-files responder (live-if-on, files-if-off).**
      - [x] Step 1: AutoAttendant picks `liveResponder` when `isLive()` is true,
            else the file `responder`; `goOnDuty`/`dutyPresence` give a file-mtime
            heartbeat presence with no daemon/IPC. (19 auto-attendant tests.)
      - [ ] Step 2: wire a real LIVE responder = a running Claude Code session
            (via the Switchboard MCP) answering from its in-memory context, and
            `switchboard-attend` ergonomics (`--on-duty` heartbeat, handle).
- [ ] **Persistent agent session** per side instead of fresh `claude -p` per turn
      (token efficiency; keeps conversation context across turns).
- [ ] **Auto-resolve**: the agent decides the matter is settled and calls resolve
      with a generated summary — currently a human types `/resolve`.
- [ ] **Terse, intent-tagged, reference-based** messages (not verbose NL);
      minimize the per-message fence overhead.

## P1 — Observability / waiting UX (user-flagged)
- [x] **Basic waiting feedback** — the CLI now prints "⏳ sent — waiting for the
      other agent…" on send, so the ~30s model latency no longer looks frozen.
- [ ] **Full "peer is thinking…" signal** from the attendant side (a `system`/status
      frame the moment it starts working), richer than the local asker-side line.
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
