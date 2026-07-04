//! RELAY <-> CLIENT control frames (client side).
//!
//! Mirror of `packages/client/src/wire.ts`. The relay brokers CIPHERTEXT ONLY:
//! a `frame` field is always base64 of `channel.seal(utf8(JSON(Message)))` — the
//! relay never unseals it, and it never appears here as anything but an opaque
//! string. These are kept byte-compatible with the relay's `ServerFrame` /
//! `ClientFrame` so the two halves can't drift.

use serde::{Deserialize, Serialize};

/// Client -> Relay control frames (discriminated on `t`).
///
/// `hangup` deliberately omits `reason` (the relay defaults it), matching the TS
/// client which sends `{ t: 'hangup', callId }`.
#[derive(Debug, Serialize)]
#[serde(tag = "t")]
pub enum ClientToRelay {
    #[serde(rename = "open", rename_all = "camelCase")]
    Open {
        rendezvous_id: String,
        from: String,
        topic: String,
        max_turns: u32,
    },
    #[serde(rename = "join", rename_all = "camelCase")]
    Join { rendezvous_id: String, from: String },
    #[serde(rename = "send", rename_all = "camelCase")]
    Send { call_id: String, frame: String },
    #[serde(rename = "hangup", rename_all = "camelCase")]
    Hangup { call_id: String },
}

/// Relay -> Client control frames. Defensively parsed off the wire; unknown
/// shapes are dropped by the caller (serde fails the deserialize).
#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub enum RelayToClient {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_serializes_camelcase() {
        let f = ClientToRelay::Open {
            rendezvous_id: "abc".into(),
            from: "@a/b".into(),
            topic: "hi".into(),
            max_turns: 5,
        };
        assert_eq!(
            serde_json::to_string(&f).unwrap(),
            r#"{"t":"open","rendezvousId":"abc","from":"@a/b","topic":"hi","maxTurns":5}"#
        );
    }

    #[test]
    fn hangup_omits_reason() {
        let f = ClientToRelay::Hangup { call_id: "call-x".into() };
        assert_eq!(serde_json::to_string(&f).unwrap(), r#"{"t":"hangup","callId":"call-x"}"#);
    }

    #[test]
    fn relay_frames_deserialize() {
        let f: RelayToClient = serde_json::from_str(r#"{"t":"opened","callId":"call-x"}"#).unwrap();
        assert!(matches!(f, RelayToClient::Opened { .. }));
        let f: RelayToClient =
            serde_json::from_str(r#"{"t":"peer-joined","callId":"c","peer":"@a/b"}"#).unwrap();
        assert!(matches!(f, RelayToClient::PeerJoined { .. }));
        // Unknown discriminator -> error (dropped by caller).
        assert!(serde_json::from_str::<RelayToClient>(r#"{"t":"nope"}"#).is_err());
    }
}
