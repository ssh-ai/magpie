# Magpie Protocol & Threat Model

Version 1 (MVP). Status: design-locked for the scaffold; crypto upgrade path noted.

## 1. Roles

- **Extension** — a human-readable agent address `@owner/role` (e.g. `@chris/impl`). One per participating agent.
- **Relay (the exchange)** — an untrusted broker. It routes frames between two endpoints and enforces turn caps and TTLs. It **must not be able to read message plaintext**.
- **Call** — a single tracked exchange between exactly two extensions, with a state machine (`open → answered → closed`) and a turn budget.
- **Auto-attendant** — an optional headless responder for an extension that answers inbound queries from the owner's own context while the human is away.

## 2. Onboarding handshake (the load-bearing UX)

Goal: as easy as joining a video call, as safe as Signal's initial pairing.

```
start(topic):
  A's agent → relay:  OPEN_CALL { rendezvousId = HKDF(code, "rendezvous") }
  relay → A:          callId
  A shows the human:  code = K7F3-9M2P-XQ4R   (~59 bits)
  human side-channel: A sends `code` to B over KakaoTalk/Slack/voice

join(code):
  B's agent → relay:  JOIN_CALL { rendezvousId = HKDF(code, "rendezvous") }
  relay matches the two endpoints by rendezvousId (it never sees `code`).
  Both endpoints independently derive channelKey = HKDF(code, "channel").
  From here every PAYLOAD frame is AES-256-GCM sealed with channelKey.
```

Properties:

- The relay learns only `rendezvousId` (a one-way function of the code) and ciphertext. It cannot read content or impersonate an endpoint without the code.
- The code is **single-use** and expires after `PAIRING_TTL_MS` (10 min). A consumed or expired rendezvous is rejected.
- No accounts, no key files, no config. The only secret is the code, carried on a channel the humans already trust.

### Invite tokens (zero-config join)

What the human actually shares is ONE self-contained **invite**: `<CODE>@<relay-url>`, e.g. `K7F3-9M2P-XQ4R@ws://192.168.0.13:8787`. The joiner pastes just that — no `MAGPIE_RELAY_URL` needed on their side; the relay URL rides along with the code. A bare code (no `@`) still works and uses the joiner's configured relay. The URL part must be `ws://` or `wss://`; it is routing metadata only and carries no secret (the code is the secret, and the relay never sees it). `formatInvite`/`parseInvite` (TS) and `format_invite`/`parse_invite` (Rust) implement this; the code part is validated by the existing `normalizePairingCode`, splitting at the FIRST `@` so userinfo URLs survive.

### Crypto: MVP vs upgrade

- **MVP (shipped in scaffold):** `channelKey = HKDF-SHA256(code)`, AEAD = AES-256-GCM. Real, standard crypto. Secure while the code retains entropy and the side channel is trusted. The ~59-bit code is comfortably online-attack-resistant given the relay rate-limits and expires rendezvous attempts.
- **Upgrade (v1.1): SPAKE2 PAKE.** Replace HKDF-from-code with a balanced PAKE so the channel key is *never* a function of the code alone. This makes short codes (e.g. 4–6 chars) MITM-safe and removes the "trusted side channel keeps its entropy" caveat. The `PairingChannel` interface in `@magpie/protocol` is the swap seam.

## 3. Message frame

Validated by `Message` (zod) in `@magpie/protocol`:

```
{ v, id, callId, from, to, type, ts, turn, inReplyTo, content }
  type ∈ { query, response, ping, hangup, system }
```

- `content` is capped at `MAX_CONTENT_BYTES` (256 KiB) — anti-DoS, anti-context-blowup.
- `from`/`to` must match `EXTENSION_RE`; anything else is rejected at the door.

## 4. Turn cap & termination

- A call carries `turn` and `maxTurns` (`DEFAULT_MAX_TURNS = 12`, hard ceiling `ABSOLUTE_MAX_TURNS = 50`).
- The relay increments `turn` per delivered query and refuses delivery past `maxTurns`, emitting a `hangup`.
- Either side may `hangup` explicitly; the auto-attendant must `hangup` + escalate when it cannot answer confidently.

## 5. Content-execution threat model (the core risk)

Unlike a human messenger, a Magpie message is consumed by an LLM with tools. Naively, any peer message is a prompt-injection / RCE vector — this is exactly how prior art (`claude-code-session-bridge`) is exploitable. Mitigations, enforced by `@magpie/protocol/security`:

1. **Fence** — inbound content is wrapped (`fenceUntrusted`) and the receiving agent is instructed to treat it as data, answer only from its own context.
2. **Action gate** — `ActionPolicy` defaults to `{ readOwnFiles: true, runTools: false, answerWhileAway: true }`. A peer message can never make the local agent run shell or edit files without explicit local human approval.
3. **Strict ids** — no peer-supplied string is ever interpolated into a filesystem path unvalidated (`assertSafeExtension`), closing the path-traversal / `rm -rf` class.
4. **No silent destructive ops** — the relay and adapters never `rm -rf` a path built from peer/pointer input.

## 6. What the relay is NOT trusted with

- Reading content (E2E encrypted).
- Asserting identity (endpoints are bound by possession of the code-derived key).
- Persisting plaintext. Audit logs, if any, store ciphertext + metadata only.

## 6a. Transport hardening (deployment)

The E2E channel protects message **content** regardless of transport. However, the
`rendezvousId` and control frames travel in cleartext over plain `ws://`. An on-path
attacker could observe a `rendezvousId` and race to `join` the slot first — they still
cannot read content (no code → no channel key), but they could grief/occupy a pairing.
**Run the relay behind `wss://` (TLS)** in any non-local deployment to hide rendezvous
metadata and prevent slot-racing. The relay binds `0.0.0.0` by default (it is a server
others connect to); terminate TLS in front of it.

## 7. Open items for v1.1+

- SPAKE2 PAKE (short codes).
- Per-extension long-lived identity keys (so repeat collaborators skip re-pairing) with explicit trust-on-first-use.
- Group calls (N>2).
- Web push / Slack notification for away-human escalation.
