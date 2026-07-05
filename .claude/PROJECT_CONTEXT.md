<!-- GIT_HASH: 52ba4bd1597931ddbd11a41c15bffd335654c08a -->
<!-- GENERATED: 2026-07-05T23:20:00+09:00 -->
<!-- PRIME_VERSION: 2.0 -->

# Project Context Cache

## 🎯 Project Overview
- **Name**: Magpie (rebranded from Switchboard; OS folder renamed from `agentmessenger`)
- **Type**: OSS agent-to-agent communication tool — "your agent talks to their agent". MCP server + relay + CLI. Self-host model, no hosted service.
- **Repo**: https://github.com/ssh-ai/magpie — **PUBLIC**, MIT, v0.1.0 released 2026-07-05
- **Site**: https://ssh-ai.github.io/magpie/ (GitHub Pages, serves install.sh too)
- **Languages**: TypeScript (reference impl + agent-glue) + Rust (wire core: relay/protocol/client/cli)
- **Tech**: WebSocket relay (ciphertext-only broker), HKDF-SHA256 + AES-256-GCM E2E from pairing code, MCP (7 tools: sb_start/join/ask/answer/listen/hangup/resolve), zod schemas, vitest, tokio/tungstenite/clap/RustCrypto, bun-compiled MCP binary.

## 🏗️ Architecture
- `packages/protocol` — schema, pairing (code → HKDF rendezvousId + channelKey), security fence. Rust twin: `rust/crates/magpie-protocol` (byte-identical crypto, cross-impl vectors in `specs/fixtures/crypto-vectors.json`).
- `packages/relay` / `rust/crates/magpie-relay` — WS rendezvous + call registry + turn cap. The ONLY internet-exposed component. Rust binary ~1 MB.
- `packages/client` / `magpie-client` — call lifecycle, join-race fix, reports to `~/.magpie/calls/`.
- `packages/mcp` — MCP server for any agent (Claude Code, Codex, Antigravity). Driving loop lives in server `instructions`. Bun-compiled to standalone `magpie-mcp` in releases.
- `packages/cli` / `magpie-cli` — start/join/call/listen/hangup/history/report.
- `packages/auto-attendant` — ClaudeResponder (headless `claude -p`, read-only tools, cwd-scoped) + AutoDriver (autonomous agree-loop). TS-only.
- `packages/web` — honest stub (join/watch works, transcript decrypt NOT ported to WebCrypto yet).
- `conformance/` — 13 scenario suites incl. Rust-relay interop; `site/` + `scripts/install.{sh,ps1}` — landing + one-line installer (installs binaries to ~/.magpie/bin, auto-registers MCP in Claude Code + Codex).
- Invite format: `CODE@ws://relay-host:8787` — self-contained; joiner needs zero config. Starter needs MAGPIE_RELAY_URL or relayUrl param.

## ✅ Verified state (2026-07-05)
- TS: 127/127 tests green (24 files). Rust: 67/67 green after `cargo clean` (stale-path artifacts from the agentmessenger→magpie folder rename poison incremental builds — clean rebuild fixed; NOT a product bug; CI green on fresh checkouts).
- CI (`ci.yml`) green on main; release (`release.yml`) built 5-platform binaries attached to v0.1.0; pages deploy green (one transient failure, later runs green).
- install.sh + site + release tarball URLs all live (HTTP 200).
- Live-verified earlier: cross-machine E2E calls, MCP in-session both directions, autonomous agree-loop (AutoDriver), claude attendant answering headlessly, in-band decline without killing call, sb_resolve conclude.

## 🚧 Known gaps (launch-readiness, from TODO.md)
- **Relay DoS hardening (HIGH, pre-public-relay)**: unbounded `pending` map per conn; unbounded outbound channel; no WS message-size cap (64 MiB default); no idle/handshake timeouts, conn caps, rate-limit, access token. Fine for LAN/Tailscale trusted pairs; NOT for public relays.
- **SPAKE2 PAKE** not done — channel key is HKDF(code); code strength is the security.
- Cross-vendor live test (Claude↔Codex) PARKED — cross-vendor claim rests on MCP standard, not live-verified.
- Mutual-confirm agree (v1.1) PARKED; persistent agent session per side (token efficiency) not done.
- npm publish not done (binary install supersedes for onboarding); wss/TLS guide not written; web transcript decrypt stub.
- Fence delimiter forgeable (needs per-message nonce); pairing-code modulo bias; TTL 10min UX pain.

## 🔧 Claude Code Integration
- No project .claude/agents, commands, hooks, or skills (only PROJECT_CONTEXT.md cache). Global user tooling only.
- Architecture map: not created (run /arch-map if needed).

## 💡 Key insights
- Product core = S2 autonomous agree-loop (two agents converse until mutual agreement, then report). One-shot Q&A is explicitly NOT the product.
- Compliance constraint (docs/COMPLIANCE.md): auth separation — never drive another person's agent on their seat; mode ③ excluded per provider ToS.
- Rust migration was distribution-motivated (single binary), not speed; LLM latency dominates (~30s/turn).
- Language boundary = wire protocol; TS and Rust interop natively; mix-and-match verified.

## 🤝 Team Assessment
Complexity ~4.5 (multi-layer 2.0 + multi-tech 1.5 + 129 files 1.0). Single-agent fine for most tasks; use workflow/agents for audits.

---

## Change Detection
Invalidated when git hash changes or this file is deleted. Force: `rm .claude/PROJECT_CONTEXT.md && /prime`
