//! Cross-impl crypto vectors — Phase 2's primary acceptance gate (§5).
//!
//! Loads the TS-reference fixture `specs/fixtures/crypto-vectors.json` and
//! asserts BYTE-IDENTICAL results:
//!   - `rendezvous_id` for every code,
//!   - channel key hex for every code,
//!   - sealing the ENCRYPT plaintext with the fixture's FIXED iv reproduces
//!     `sealedB64` exactly (and the detached tag matches `tagHex`),
//!   - opening the genuine TS-sealed `realSealedB64` recovers the plaintext.

use serde_json::Value;
use magpie_protocol::pairing::{frame_from_b64, frame_to_b64};
use magpie_protocol::{channel_from_code, channel_key, rendezvous_id};

fn load_fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../specs/fixtures/crypto-vectors.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read fixture {path}: {e}"));
    serde_json::from_str(&raw).expect("fixture is valid JSON")
}

#[test]
fn rendezvous_and_channel_key_match_ts() {
    let fx = load_fixture();
    let codes = fx["codes"].as_array().expect("codes array");
    assert!(!codes.is_empty(), "fixture has at least one code");

    for c in codes {
        let code = c["code"].as_str().unwrap();
        let want_rid = c["rendezvousId"].as_str().unwrap();
        let want_key = c["channelKeyHex"].as_str().unwrap();

        let got_rid = rendezvous_id(code).unwrap();
        assert_eq!(got_rid, want_rid, "rendezvousId mismatch for {code}");

        let got_key = hex::encode(channel_key(code).unwrap());
        assert_eq!(got_key, want_key, "channelKeyHex mismatch for {code}");

        // Sanity: normalized form matches the fixture's expectation.
        let want_norm = c["normalized"].as_str().unwrap();
        let got_norm =
            magpie_protocol::normalize_pairing_code(code).unwrap();
        assert_eq!(got_norm, want_norm, "normalized mismatch for {code}");
    }
}

/// The byte-exact SEAL side of the ENCRYPT vector (fixed-IV) lives as a unit
/// test in `src/pairing.rs` — `seal_with_iv` is private (nonce-reuse footgun).
/// From the outside, verify the same vector via the open() direction plus a
/// random-IV round trip.
#[test]
fn encrypt_vector_opens_and_round_trips() {
    let fx = load_fixture();
    let enc = &fx["encrypt"];
    let code = enc["code"].as_str().unwrap();
    let plaintext = enc["plaintextUtf8"].as_str().unwrap();
    let want_sealed_b64 = enc["sealedB64"].as_str().unwrap();

    let channel = channel_from_code(code).unwrap();

    // Opening the fixture's exact sealed bytes recovers the plaintext.
    let frame = frame_from_b64(want_sealed_b64).unwrap();
    assert_eq!(channel.open(&frame).unwrap(), plaintext.as_bytes());

    // And a fresh (random-IV) seal round-trips through the same channel.
    let resealed = channel.seal(plaintext.as_bytes());
    assert_eq!(channel.open(&resealed).unwrap(), plaintext.as_bytes());
    assert!(!frame_to_b64(&resealed).is_empty());
}

#[test]
fn opens_genuine_ts_sealed_frame() {
    let fx = load_fixture();
    let dec = &fx["decrypt"];
    let code = dec["code"].as_str().unwrap();
    let want_plaintext = dec["plaintextUtf8"].as_str().unwrap();
    let real_sealed_b64 = dec["realSealedB64"].as_str().unwrap();

    let channel = channel_from_code(code).unwrap();
    let frame = frame_from_b64(real_sealed_b64).unwrap();
    let recovered = channel.open(&frame).unwrap();
    assert_eq!(
        String::from_utf8(recovered).unwrap(),
        want_plaintext,
        "failed to open genuine TS-sealed frame"
    );
}
