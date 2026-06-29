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
use switchboard_protocol::pairing::{frame_from_b64, frame_to_b64};
use switchboard_protocol::{channel_from_code, channel_key, rendezvous_id};

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
            switchboard_protocol::normalize_pairing_code(code).unwrap();
        assert_eq!(got_norm, want_norm, "normalized mismatch for {code}");
    }
}

#[test]
fn encrypt_vector_reproduces_sealed_bytes() {
    let fx = load_fixture();
    let enc = &fx["encrypt"];
    let code = enc["code"].as_str().unwrap();
    let plaintext = enc["plaintextUtf8"].as_str().unwrap();
    let iv_hex = enc["ivHex"].as_str().unwrap();
    let tag_hex = enc["tagHex"].as_str().unwrap();
    let ct_hex = enc["ciphertextHex"].as_str().unwrap();
    let want_sealed_b64 = enc["sealedB64"].as_str().unwrap();

    let iv_vec = hex::decode(iv_hex).unwrap();
    let iv: [u8; 12] = iv_vec.as_slice().try_into().expect("12-byte iv");

    let channel = channel_from_code(code).unwrap();
    let frame = channel.seal_with_iv(&iv, plaintext.as_bytes());

    // Layout: iv(12) ‖ tag(16) ‖ ct.
    assert_eq!(&frame[0..12], iv.as_slice(), "iv prefix");
    assert_eq!(hex::encode(&frame[12..28]), tag_hex, "detached tag mismatch");
    assert_eq!(hex::encode(&frame[28..]), ct_hex, "ciphertext mismatch");

    let got_b64 = frame_to_b64(&frame);
    assert_eq!(got_b64, want_sealed_b64, "sealedB64 not byte-identical to TS");

    // And the frame round-trips through open().
    let recovered = channel.open(&frame).unwrap();
    assert_eq!(recovered, plaintext.as_bytes());
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
