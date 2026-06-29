# Switchboard — Rust migration plan

Status: **DRAFT for review** · decided 2026-06-29 · owner: Chris

## 0. Decision (locked)

- **Surgical split, not a big-bang rewrite.** Rust takes the durable wire/infra
  core; TypeScript keeps the SDK- and agent-coupled glue.
  - **→ Rust:** `relay`, `protocol` (crypto + schema), `client`, `cli`.
  - **→ stays TS (reassess later):** `mcp` (most MCP-SDK-coupled, fastest-moving)
    and `auto-attendant`/driver (it just spawns `claude -p` — Rust buys nothing).
- **Boundary = the wire protocol** (WebSocket control frames + base64 sealed
  ciphertext). Both languages speak it, so components interop natively and we
  migrate **one package at a time** with the rest unchanged.
- **Process:** this doc is the gate. No further migration code lands until it is
  reviewed and the per-phase acceptance gates are agreed.

## 1. Why Rust (honest)

The core call path is **LLM-bound (~20–60 s/turn)**, so Rust does **not** speed up
a conversation — that would be optimizing the wrong thing. The real, defensible
wins:

1. **Distribution / cold-start** — single static binary (`brew install`, no Node
   runtime). Serves the "easy onboarding incl. non-developers" goal. CLI start
   ~5 ms vs Node ~150 ms.
2. **Relay at scale** — tokio, no GC tail-latency, KB/connection not tens-of-KB.
   Matters once a hosted relay brokers many concurrent calls (not day 1).
3. **Smaller attack surface** on the one publicly-exposed component (relay).

Explicitly NOT claimed: faster conversations. The bigger *efficiency* levers are
not the language — token efficiency (persistent agent sessions) + a terse/
reference-based protocol dwarf any rewrite (tracked separately in TODO.md).

## 2. Scope & sizes

Non-test source LOC (2026-06-29):

| package | LOC | external deps | migrate? |
|---|---|---|---|
| protocol | 337 | zod, nanoid | **Rust (Phase 2)** |
| relay | 673 | ws | **Rust (Phase 1)** |
| client | 598 | ws | **Rust (Phase 3)** |
| cli | 708 | commander | **Rust (Phase 3)** |
| mcp | 964 | @modelcontextprotocol/sdk, zod | stays TS |
| auto-attendant | 948 | (none) | stays TS |
| web | 100 | (none) | stays TS (browser) |

Durable wire core to port = protocol + relay + client ≈ **1.6k LOC**.

## 3. Repo layout

```
agentmessenger/
  packages/         # TypeScript (npm workspaces) — unchanged
  rust/             # Cargo workspace (the Rust half)
    Cargo.toml
    crates/
      switchboard-relay/      # Phase 1  (DONE: prototype, unverified interop)
      switchboard-protocol/   # Phase 2  (crypto + schema)
      switchboard-client/     # Phase 3
      switchboard-cli/        # Phase 3  (the distributable binary)
  specs/RUST_MIGRATION.md     # this doc
```

The two toolchains are independent: `tsc`/npm only see `packages/*`; `cargo`
only sees `rust/*`. No build coupling.

## 4. Frozen wire contract (Phase 1) — source of interop

Mirror of `packages/relay/src/wire.ts`. A Rust relay MUST emit/accept exactly
these JSON shapes so the existing TS client connects unchanged.

**Client → Relay** (discriminated on `t`):

| t | fields |
|---|---|
| `open` | `rendezvousId` (32 lc-hex), `from` (`@owner/role`), `topic` (≤2000), `maxTurns?` (int>0) |
| `join` | `rendezvousId`, `from` |
| `send` | `callId` (`call-[A-Za-z0-9_-]{10,}`), `frame` (base64, ≤1.5 MB) |
| `hangup` | `callId`, `reason?` (≤500) |

**Relay → Client:**

| t | fields |
|---|---|
| `opened` | `callId` |
| `joined` | `callId`, `peer` |
| `peer-joined` | `callId`, `peer` |
| `deliver` | `callId`, `frame` |
| `hangup` | `callId`, `reason` |
| `error` | `code`, `message` |

**Error codes:** `BAD_FRAME`, `UNKNOWN_RENDEZVOUS`, `EXPIRED`, `ALREADY_PAIRED`,
`NOT_PARTICIPANT`, `UNKNOWN_CALL`, `CALL_CLOSED`, `TURN_CAP`, `PEER_GONE`.

**Semantics that must match:** single-use rendezvous; pairing TTL 10 min →
`EXPIRED`/`UNKNOWN_RENDEZVOUS`; turn cap = every delivered `send` counts one turn,
clamp `[1,50]`, default 12; on cap → close + `hangup` to BOTH ends; on disconnect
→ `hangup` peer with "peer disconnected"; idle reap 1 h. The relay is **crypto-
free** — it never unseals `frame`.

> Known minor deviation: zod uses `.strict()` (reject unknown keys); serde is
> lenient by default. Not a security issue for a ciphertext broker. Decide in
> Phase 1 whether to add `deny_unknown_fields` for exact parity.

## 5. Crypto/protocol contract (Phase 2) — the load-bearing risk

A Rust client must produce **byte-identical** crypto to TS or cross-language calls
fail. Exact spec from `packages/protocol/src/pairing.ts`:

- **Code normalize:** uppercase, strip non-`[A-Z0-9]`, length = `CODE_GROUPS *
  CODE_GROUP_LEN`, all chars ∈ `CODE_ALPHABET` (see `constants.ts`).
- **rendezvousId** = `HKDF-SHA256(ikm = utf8(norm), salt = "", info =
  "switchboard:rendezvous:v1", L = 16)` → lowercase hex (32 chars).
- **channel key** = `HKDF-SHA256(ikm = utf8(norm), salt = "", info =
  "switchboard:channel:v1", L = 32)`.
- **seal:** `iv = random 12B`; `AES-256-GCM(key, iv, plaintext)`, no AAD; tag 16B;
  **frame = iv ‖ tag ‖ ciphertext**; wire = base64(frame).
- **open:** split `iv=[0:12]`, `tag=[12:28]`, `ct=[28:]`; GCM verify+decrypt.

Rust crates (pure-Rust, easy static cross-compile): `hkdf` + `sha2`, `aes-gcm`.

Implementation notes / risks:
- `aes-gcm` appends the tag to ciphertext by default → use the **detached-tag**
  API (`encrypt_in_place_detached`) to lay out `iv ‖ tag ‖ ct` exactly.
- Empty HKDF salt: Node `Buffer.alloc(0)`, RustCrypto `Hkdf::new(Some(&[]), ikm)`
  — equivalent after HMAC zero-padding, but **must be confirmed by test vector**.
- nanoid: `nanoid` crate default = 21 url-safe chars → matches `CallId` regex.

**De-risk mechanism — shared crypto test vectors:** a TS script emits a JSON
fixture `{ code, rendezvousId, channelKeyHex, plaintextHex, ivHex, sealedHex }`;
a Rust test reproduces `rendezvousId`, `channelKey`, and (given the fixed iv) the
sealed bytes, and decrypts the TS-sealed frame. Committed as the cross-impl
corpus. This is Phase 2's primary acceptance gate.

## 6. Phases, gates, status

### Phase 1 — `switchboard-relay` (drop-in)
- **Deliverable:** Rust relay binary, wire-identical to the TS relay.
- **Crates:** tokio, tokio-tungstenite (pinned 0.21), futures-util, serde/serde_json, nanoid.
- **Status:** ⚠️ PROTOTYPE BUILT (`frames.rs`/`registry.rs`/`main.rs`, 13 unit
  tests green) — **interop NOT yet verified** (gate below not yet run).
- **Acceptance gates:**
  1. `cargo test` green. ✅
  2. **Interop:** existing TS `SwitchboardClient` does start/join/ask/answer/
     hangup through the Rust relay; error path (unknown rendezvous) rejected.
     (script written: `scratchpad/rust-relay-interop.mjs`, not yet run.)
  3. **Conformance parity:** the Rust relay passes the existing scenarios
     (two-party-only, hangup-notifies-peer, discovery-wrong-code, rejoin-expired,
     turn-cap, immediate-send-on-join). Requires making the conformance harness
     accept an external relay URL (small refactor) OR replicating the 6 scenarios
     as a Rust-relay integration test driven by the TS client.

### Phase 2 — `switchboard-protocol` (crypto + schema)
- **Deliverable:** crate exporting `rendezvous_id`, `channel_from_code` (seal/
  open), message types (serde) + validators (extension/callId/size caps).
- **Crates:** hkdf, sha2, aes-gcm, serde/serde_json, rand, nanoid.
- **Acceptance gates:** shared crypto test vectors reproduced bit-for-bit (§5);
  a Rust-sealed frame opened by TS and vice-versa.

### Phase 3 — `switchboard-client` + `switchboard-cli`
- **Deliverable:** Rust client (ws + protocol) and a single-binary CLI
  (`commander`→`clap`) with start/join/ask/answer/resolve + report.
- **Acceptance gates:** Rust CLI ⇄ TS peer E2E call (over either relay); static
  binaries build for `aarch64/x86_64-apple-darwin` + `x86_64-unknown-linux-musl`;
  record binary size + cold-start vs the Node CLI.

## 7. Cross-impl conformance strategy

The risk of two protocol implementations is **drift**. Mitigation: one shared,
language-neutral corpus both sides must pass —
- wire-frame fixtures (control frames → expected routing),
- crypto vectors (§5),
- the 6 relay scenarios run against BOTH relays.
TS remains the reference implementation; Rust must match it, not the reverse.

## 8. Distribution (the actual payoff)

- `cargo build --release` per target; strip; measure size (<5 MB goal).
- Homebrew tap + GitHub Releases (CI matrix: macos arm64/x64, linux musl).
- Goal artifact: `brew install switchboard` → relay + CLI, no Node required.
  (MCP server stays an npm package for now; that's fine — agents that use MCP
  already have a Node/host runtime.)

## 9. Risk register

| risk | likelihood | mitigation |
|---|---|---|
| Crypto not byte-identical (HKDF salt / GCM layout) | med | shared test vectors before any client work (§5) |
| tungstenite API drift across versions | low | pinned 0.21; `Message::Text(String)` API |
| serde leniency vs zod `.strict()` | low | optional `deny_unknown_fields`; decide Phase 1 |
| protocol drift over time (2 impls) | med | shared conformance corpus is CI-blocking |
| polyglot CI/build complexity | med | independent toolchains; separate CI jobs |
| scope creep into MCP/auto-attendant | med | explicitly out of scope (this doc); revisit only if endgame changes |

## 10. Open decisions (log)

- [resolved 2026-06-29] End-state = **surgical split** (not full-Rust).
- [open] Phase 1 conformance: refactor TS harness to take a relay URL, vs a
  dedicated Rust integration test? (decide at Phase 1 gate 3.)
- [open] Add `deny_unknown_fields` to Rust frames for exact `.strict()` parity?
- [deferred] Full-Rust incl. `rmcp` MCP server — revisit only if the surgical
  split proves insufficient.
```
