//! Wire message schema + validators.
//!
//! Mirror of `packages/protocol/src/schema.ts`. The TS reference uses zod;
//! since this crate avoids a regex dependency, the equivalent constraints are
//! enforced with hand-written ASCII validators that match the zod regexes
//! exactly:
//!   - extension: `^@[a-z0-9](?:[a-z0-9-]{0,30})/[a-z0-9](?:[a-z0-9-]{0,30})$`
//!   - messageId: `^msg-[A-Za-z0-9_-]{10,}$`
//!   - callId:    `^call-[A-Za-z0-9_-]{10,}$`

use serde::{Deserialize, Serialize};

use crate::constants::{MAX_CONTENT_BYTES, PROTOCOL_VERSION};
use crate::error::{ProtocolError, Result};

/// True iff `b` is one of `[A-Za-z0-9_-]` (the id "body" alphabet).
fn is_id_body(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Validate an extension address `@<owner>/<role>`.
///
/// Equivalent to `EXTENSION_RE`. Both `owner` and `role` are `[a-z0-9]`
/// followed by up to 30 of `[a-z0-9-]`.
pub fn is_valid_extension(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'@') {
        return false;
    }
    // Split the remainder on the FIRST '/'.
    let rest = &s[1..];
    let slash = match rest.find('/') {
        Some(i) => i,
        None => return false,
    };
    let owner = &rest[..slash];
    let role = &rest[slash + 1..];
    valid_label(owner) && valid_label(role)
}

/// A label is `[a-z0-9]` then up to 30 of `[a-z0-9-]` (total 1..=31 chars).
fn valid_label(label: &str) -> bool {
    let b = label.as_bytes();
    if b.is_empty() || b.len() > 31 {
        return false;
    }
    let lc_alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    if !lc_alnum(b[0]) {
        return false;
    }
    b[1..].iter().all(|&c| lc_alnum(c) || c == b'-')
}

/// Validate a message id: `msg-` + at least 10 of `[A-Za-z0-9_-]`.
pub fn is_valid_message_id(s: &str) -> bool {
    is_prefixed_id(s, "msg-")
}

/// Validate a call id: `call-` + at least 10 of `[A-Za-z0-9_-]`.
pub fn is_valid_call_id(s: &str) -> bool {
    is_prefixed_id(s, "call-")
}

fn is_prefixed_id(s: &str, prefix: &str) -> bool {
    match s.strip_prefix(prefix) {
        Some(body) => body.len() >= 10 && body.bytes().all(is_id_body),
        None => false,
    }
}

/// True iff `content` is within the byte cap (UTF-8 byte length, matching
/// Node's `Buffer.byteLength(s, 'utf8')`).
pub fn content_within_cap(content: &str) -> bool {
    content.len() <= MAX_CONTENT_BYTES
}

/// Message type discriminator. Serialized lowercase to match the TS enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageType {
    Query,
    Response,
    Ping,
    Hangup,
    System,
    Resolve,
}

/// Call lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallState {
    Open,
    Answered,
    Closed,
}

/// How a call ended. `resolved` is the good outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallOutcome {
    Resolved,
    #[serde(rename = "turn-cap")]
    TurnCap,
    #[serde(rename = "hung-up")]
    HungUp,
    Disconnected,
}

/// True iff `s` is an ISO-8601 UTC datetime of the shape zod's `.datetime()`
/// accepts: `YYYY-MM-DDTHH:MM:SS[.fff...]Z` (Z-suffixed, no offsets).
fn is_iso_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    // Fixed prefix: YYYY-MM-DDTHH:MM:SS = 19 bytes; suffix `Z` = 1.
    if b.len() < 20 || *b.last().unwrap() != b'Z' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let num = |r: std::ops::Range<usize>| -> u32 {
        s[r].parse().unwrap_or(u32::MAX)
    };
    let shape = digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19);
    if !shape {
        return false;
    }
    // Optional fractional seconds between seconds and the trailing Z.
    let frac = &b[19..b.len() - 1];
    if !frac.is_empty() && (frac[0] != b'.' || frac.len() < 2 || !digits(20..b.len() - 1)) {
        return false;
    }
    (1..=12).contains(&num(5..7))
        && (1..=31).contains(&num(8..10))
        && num(11..13) <= 23
        && num(14..16) <= 59
        && num(17..19) <= 59
}

/// The canonical wire message. Mirrors the zod `Message` shape, including its
/// `.strict()` unknown-field rejection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub v: u8,
    pub id: String,
    #[serde(rename = "callId")]
    pub call_id: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub r#type: MessageType,
    pub ts: String,
    pub turn: u64,
    #[serde(rename = "inReplyTo")]
    pub in_reply_to: Option<String>,
    /// Caller-supplied text — ALWAYS untrusted data to receivers (see `security`).
    pub content: String,
}

impl Message {
    /// Enforce the schema invariants zod's `.parse` would. Returns the validated
    /// message or a `ProtocolError::Validation`.
    pub fn validate(self) -> Result<Self> {
        if self.v != PROTOCOL_VERSION {
            return Err(ProtocolError::Validation(format!(
                "v must be {PROTOCOL_VERSION}, got {}",
                self.v
            )));
        }
        if !is_valid_message_id(&self.id) {
            return Err(ProtocolError::Validation(format!("invalid id: {}", self.id)));
        }
        if !is_valid_call_id(&self.call_id) {
            return Err(ProtocolError::Validation(format!(
                "invalid callId: {}",
                self.call_id
            )));
        }
        if !is_valid_extension(&self.from) {
            return Err(ProtocolError::Validation(format!(
                "invalid from extension: {}",
                self.from
            )));
        }
        if !is_valid_extension(&self.to) {
            return Err(ProtocolError::Validation(format!(
                "invalid to extension: {}",
                self.to
            )));
        }
        if !is_iso_datetime(&self.ts) {
            return Err(ProtocolError::Validation(format!(
                "invalid ts (expected ISO-8601 UTC): {}",
                self.ts
            )));
        }
        if let Some(ref r) = self.in_reply_to {
            if !is_valid_message_id(r) {
                return Err(ProtocolError::Validation(format!(
                    "invalid inReplyTo: {r}"
                )));
            }
        }
        if !content_within_cap(&self.content) {
            return Err(ProtocolError::Validation(format!(
                "content exceeds {MAX_CONTENT_BYTES} bytes"
            )));
        }
        Ok(self)
    }
}

/// Parse + validate an inbound wire frame (JSON value). Mirrors `parseMessage`.
pub fn parse_message(raw: &str) -> Result<Message> {
    let msg: Message =
        serde_json::from_str(raw).map_err(|e| ProtocolError::Validation(e.to_string()))?;
    msg.validate()
}
