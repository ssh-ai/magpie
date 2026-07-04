//! Magpie protocol constants.
//!
//! Mirror of `packages/protocol/src/constants.ts`. These are security- and
//! UX-load-bearing; changing them changes the threat model or the onboarding
//! feel — touch deliberately.

/// Max bytes of a single message `content` field. Anti-DoS / anti-context-blowup.
pub const MAX_CONTENT_BYTES: usize = 256 * 1024; // 256 KiB

/// Default cap on the number of turns in a single call before auto-hangup + escalate.
pub const DEFAULT_MAX_TURNS: u32 = 12;

/// Hard ceiling — a call may never exceed this regardless of caller override.
pub const ABSOLUTE_MAX_TURNS: u32 = 50;

/// A pairing code is single-use and expires this long after `start`.
pub const PAIRING_TTL_MS: u64 = 10 * 60 * 1000; // 10 minutes

/// How long an idle call stays open before the relay reaps it.
pub const CALL_IDLE_TTL_MS: u64 = 60 * 60 * 1000; // 1 hour

/// Wire protocol version. Bumped on any breaking change to message/pairing shape.
pub const PROTOCOL_VERSION: u8 = 1;

/// Pairing-code alphabet: Crockford-style, no ambiguous characters (no I/L/O/0/1).
/// Human-transcribable over voice/chat.
pub const CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// Number of groups in a pairing code, e.g. `K7F3-9M2P-XQ4R`.
pub const CODE_GROUPS: usize = 3;
/// Length of each group in a pairing code.
pub const CODE_GROUP_LEN: usize = 4;

/// Total normalized pairing-code length (`CODE_GROUPS * CODE_GROUP_LEN`).
pub const CODE_TOTAL_LEN: usize = CODE_GROUPS * CODE_GROUP_LEN;
