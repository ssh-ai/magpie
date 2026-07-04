//! `magpie-protocol` — the canonical wire contract, in Rust.
//!
//! Mirror of the TypeScript `@magpie/protocol` (`packages/protocol`):
//! HKDF-SHA256 rendezvous/channel derivation, AES-256-GCM seal/open, and the
//! message schema + validators. The crypto is byte-identical to the TS
//! reference (enforced by the shared cross-impl vectors in `tests/`), so a Rust
//! client and a TS client can pair and decrypt each other's frames.

pub mod constants;
pub mod error;
pub mod invite;
pub mod pairing;
pub mod schema;

pub use constants::*;
pub use error::{ProtocolError, Result};
pub use invite::{format_invite, parse_invite, Invite};
pub use pairing::{
    channel_from_code, channel_key, frame_from_b64, frame_to_b64, generate_pairing_code,
    normalize_pairing_code, rendezvous_id, PairingChannel,
};
pub use schema::{
    content_within_cap, is_valid_call_id, is_valid_extension, is_valid_message_id, parse_message,
    CallOutcome, CallState, Message, MessageType,
};

use nanoid::nanoid;

/// Id alphabet — mirrors the TS `idChars` (Crockford-ish + lower + `_-`).
const ID_CHARS: [char; 58] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J',
    'K', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e',
    'f', 'g', 'h', 'j', 'k', 'm', 'n', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '_',
    '-',
];

/// Generate a fresh message id (`msg-` + 16 id chars). Matches `MessageId`.
pub fn new_message_id() -> String {
    format!("msg-{}", nanoid!(16, &ID_CHARS))
}

/// Generate a fresh call id (`call-` + 16 id chars). Matches `CallId`.
pub fn new_call_id() -> String {
    format!("call-{}", nanoid!(16, &ID_CHARS))
}
