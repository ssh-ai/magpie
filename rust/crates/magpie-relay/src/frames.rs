//! RELAY <-> CLIENT control frames + validation.
//!
//! Mirrors `packages/relay/src/wire.ts`. These are the transport-control
//! envelopes spoken over the WebSocket — NOT the end-to-end Message. The relay
//! validates and routes them but treats every `frame` field as opaque sealed
//! ciphertext (base64). It NEVER unseals, parses, or interprets a payload, and
//! never touches the filesystem.

use serde::{Deserialize, Serialize};

/// Maximum sealed-frame length (base64), matching the TS `SealedFrame` cap.
pub const MAX_SEALED_FRAME: usize = 1_500_000;
pub const MAX_TOPIC: usize = 2000;
pub const MAX_REASON: usize = 500;

/// WebSocket message/frame size cap. The largest legal control frame is a
/// `send` carrying a MAX_SEALED_FRAME payload plus envelope overhead, so 2 MiB
/// bounds every honest frame while killing the tungstenite 64 MiB default.
pub const MAX_WS_MSG: usize = 2 * 1024 * 1024;

/// Client -> Relay control frames (discriminated on `t`).
#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub enum ClientFrame {
    #[serde(rename = "open", rename_all = "camelCase")]
    Open {
        rendezvous_id: String,
        from: String,
        topic: String,
        #[serde(default)]
        max_turns: Option<u32>,
    },
    #[serde(rename = "join", rename_all = "camelCase")]
    Join { rendezvous_id: String, from: String },
    #[serde(rename = "send", rename_all = "camelCase")]
    Send { call_id: String, frame: String },
    #[serde(rename = "hangup", rename_all = "camelCase")]
    Hangup {
        call_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

/// Parse a client frame STRICTLY: unknown fields are rejected, mirroring the
/// zod `.strict()` schemas in the TS relay (`wire.ts`). Serde cannot express
/// `deny_unknown_fields` on an internally-tagged enum, so key allowlists are
/// checked on the raw JSON object before deserializing.
pub fn parse_client_frame(text: &str) -> Result<ClientFrame, &'static str> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "control frame is not valid JSON")?;
    let obj = value.as_object().ok_or("control frame is not a JSON object")?;
    let t = obj.get("t").and_then(|v| v.as_str()).ok_or("missing frame tag `t`")?;
    let allowed: &[&str] = match t {
        "open" => &["t", "rendezvousId", "from", "topic", "maxTurns"],
        "join" => &["t", "rendezvousId", "from"],
        "send" => &["t", "callId", "frame"],
        "hangup" => &["t", "callId", "reason"],
        _ => return Err("unknown frame tag"),
    };
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("unexpected field in control frame");
    }
    serde_json::from_value(value).map_err(|_| "malformed control frame")
}

/// Relay -> Client control frames.
#[derive(Debug, Serialize)]
#[serde(tag = "t")]
pub enum ServerFrame {
    #[serde(rename = "opened", rename_all = "camelCase")]
    Opened { call_id: String },
    #[serde(rename = "joined", rename_all = "camelCase")]
    Joined { call_id: String, peer: String },
    #[serde(rename = "peer-joined", rename_all = "camelCase")]
    PeerJoined { call_id: String, peer: String },
    #[serde(rename = "deliver", rename_all = "camelCase")]
    Deliver { call_id: String, frame: String },
    #[serde(rename = "hangup", rename_all = "camelCase")]
    Hangup { call_id: String, reason: String },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

impl ServerFrame {
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        ServerFrame::Error { code: code.into(), message: message.into() }
    }
    /// Serialize to the exact JSON the TS client expects.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"t":"error","code":"BAD_FRAME","message":"serialize failure"}"#.into()
        })
    }
}

/// `rendezvousId`: 32-char lowercase hex (a 16-byte HKDF digest).
pub fn is_rendezvous_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Extension address `@owner/role`, mirroring EXTENSION_RE:
/// `^@[a-z0-9](?:[a-z0-9-]{0,30})\/[a-z0-9](?:[a-z0-9-]{0,30})$`
pub fn is_extension(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('@') else { return false };
    let mut parts = rest.splitn(2, '/');
    let owner = parts.next().unwrap_or("");
    let Some(role) = parts.next() else { return false };
    is_segment(owner) && is_segment(role)
}

/// One address segment: `[a-z0-9]` then up to 30 of `[a-z0-9-]` (total 1..=31).
fn is_segment(seg: &str) -> bool {
    let b = seg.as_bytes();
    if b.is_empty() || b.len() > 31 {
        return false;
    }
    let head = b[0];
    if !(head.is_ascii_lowercase() || head.is_ascii_digit()) {
        return false;
    }
    b[1..]
        .iter()
        .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// `callId`: `^call-[A-Za-z0-9_-]{10,}$`.
pub fn is_call_id(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("call-") else { return false };
    rest.len() >= 10 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Sealed frame: base64 `[A-Za-z0-9+/]+={0,2}`, length 1..=MAX_SEALED_FRAME.
pub fn is_sealed_frame(s: &str) -> bool {
    let n = s.len();
    if n == 0 || n > MAX_SEALED_FRAME {
        return false;
    }
    let bytes = s.as_bytes();
    let mut end = n;
    let mut pad = 0;
    while end > 0 && bytes[end - 1] == b'=' && pad < 2 {
        end -= 1;
        pad += 1;
    }
    if end == 0 {
        return false; // all padding, no payload
    }
    bytes[..end]
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendezvous_id_is_32_hex() {
        assert!(is_rendezvous_id("0123456789abcdef0123456789abcdef"));
        assert!(!is_rendezvous_id("0123456789ABCDEF0123456789abcdef")); // uppercase
        assert!(!is_rendezvous_id("abc")); // too short
        assert!(!is_rendezvous_id("g123456789abcdef0123456789abcdef")); // non-hex
    }

    #[test]
    fn extension_matches_regex() {
        assert!(is_extension("@chris/impl"));
        assert!(is_extension("@b/risk-2"));
        assert!(!is_extension("chris/impl")); // no @
        assert!(!is_extension("@chris")); // no role
        assert!(!is_extension("@Chris/impl")); // uppercase head
        assert!(!is_extension("@-x/y")); // head is '-'
        assert!(!is_extension("@a/b/c")); // extra slash
    }

    #[test]
    fn call_id_matches_regex() {
        assert!(is_call_id("call-V1StGXR8_Z5jdHi6B-myT"));
        assert!(!is_call_id("call-short")); // < 10
        assert!(!is_call_id("xcall-1234567890"));
    }

    #[test]
    fn sealed_frame_is_base64_bounded() {
        assert!(is_sealed_frame("aGVsbG8="));
        assert!(is_sealed_frame("AAAA"));
        assert!(!is_sealed_frame("")); // empty
        assert!(!is_sealed_frame("has space")); // invalid char
        assert!(!is_sealed_frame("==")); // padding only
    }

    #[test]
    fn client_frame_deserializes_camelcase() {
        let f: ClientFrame =
            serde_json::from_str(r#"{"t":"open","rendezvousId":"x","from":"@a/b","topic":"hi","maxTurns":5}"#)
                .unwrap();
        match f {
            ClientFrame::Open { rendezvous_id, from, topic, max_turns } => {
                assert_eq!(rendezvous_id, "x");
                assert_eq!(from, "@a/b");
                assert_eq!(topic, "hi");
                assert_eq!(max_turns, Some(5));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn strict_parse_rejects_unknown_fields_matching_zod_strict() {
        // Baseline: a clean frame parses.
        assert!(parse_client_frame(r#"{"t":"join","rendezvousId":"x","from":"@a/b"}"#).is_ok());
        // Unknown field → rejected (zod `.strict()` parity).
        assert!(parse_client_frame(r#"{"t":"join","rendezvousId":"x","from":"@a/b","evil":1}"#)
            .is_err());
        assert!(parse_client_frame(r#"{"t":"send","callId":"c","frame":"AAAA","x":true}"#)
            .is_err());
        // Unknown tag, non-object, garbage → rejected.
        assert!(parse_client_frame(r#"{"t":"admin"}"#).is_err());
        assert!(parse_client_frame(r#"[1,2]"#).is_err());
        assert!(parse_client_frame("nope").is_err());
    }

    #[test]
    fn server_frame_serializes_with_tag() {
        let j = ServerFrame::Opened { call_id: "call-x".into() }.to_json();
        assert_eq!(j, r#"{"t":"opened","callId":"call-x"}"#);
        let j = ServerFrame::PeerJoined { call_id: "c".into(), peer: "@a/b".into() }.to_json();
        assert_eq!(j, r#"{"t":"peer-joined","callId":"c","peer":"@a/b"}"#);
    }
}
