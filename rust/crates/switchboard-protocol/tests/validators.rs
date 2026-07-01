//! Validator unit tests + a seal→open round-trip + id/code generation shape.

use switchboard_protocol::pairing::{frame_from_b64, frame_to_b64};
use switchboard_protocol::{
    channel_from_code, content_within_cap, generate_pairing_code, is_valid_call_id,
    is_valid_extension, is_valid_message_id, new_call_id, new_message_id, normalize_pairing_code,
    parse_message, rendezvous_id, MAX_CONTENT_BYTES,
};

#[test]
fn extension_validator_matches_regex() {
    // Valid.
    assert!(is_valid_extension("@chris/impl"));
    assert!(is_valid_extension("@sora/strategy"));
    assert!(is_valid_extension("@a/b"));
    assert!(is_valid_extension("@a1-b/c2-d"));
    // 31-char labels (1 + 30) are the max.
    let max_label = format!("@a{}/b{}", "c".repeat(30), "d".repeat(30));
    assert!(is_valid_extension(&max_label));

    // Invalid.
    assert!(!is_valid_extension("chris/impl"), "missing @");
    assert!(!is_valid_extension("@/impl"), "empty owner");
    assert!(!is_valid_extension("@chris/"), "empty role");
    assert!(!is_valid_extension("@chris"), "no slash");
    assert!(!is_valid_extension("@Chris/impl"), "uppercase not allowed");
    assert!(!is_valid_extension("@-chris/impl"), "label cannot start with -");
    assert!(!is_valid_extension("@chris/impl/extra"), "second slash");
    assert!(!is_valid_extension("@chris/impl/.."), "path traversal");
    let too_long = format!("@a{}/b", "c".repeat(31));
    assert!(!is_valid_extension(&too_long), "label > 31 chars");
}

#[test]
fn id_validators_match_regex() {
    assert!(is_valid_message_id("msg-abcdef1234"));
    assert!(is_valid_message_id("msg-AB_cd-1234ZZ"));
    assert!(!is_valid_message_id("msg-short"), "needs >= 10 body chars");
    assert!(!is_valid_message_id("call-abcdef1234"), "wrong prefix");
    assert!(!is_valid_message_id("msg-abcd!12345"), "illegal char");

    assert!(is_valid_call_id("call-abcdef1234"));
    assert!(is_valid_call_id("call-AB_cd-1234ZZ"));
    assert!(!is_valid_call_id("call-short"));
    assert!(!is_valid_call_id("msg-abcdef1234"));
}

#[test]
fn content_cap() {
    assert!(content_within_cap("hi"));
    assert!(content_within_cap(&"x".repeat(MAX_CONTENT_BYTES)));
    assert!(!content_within_cap(&"x".repeat(MAX_CONTENT_BYTES + 1)));
    // Multi-byte UTF-8 counts BYTES, not chars (matches Buffer.byteLength).
    let near = "\u{20AC}".repeat(MAX_CONTENT_BYTES / 3); // U+20AC (euro) is 3 UTF-8 bytes
    assert!(content_within_cap(&near));
}

#[test]
fn parse_message_accepts_valid_and_rejects_malformed() {
    let good = r#"{
        "v": 1,
        "id": "msg-abcdef1234",
        "callId": "call-abcdef1234",
        "from": "@chris/impl",
        "to": "@sora/strategy",
        "type": "query",
        "ts": "2026-06-29T00:00:00.000Z",
        "turn": 0,
        "inReplyTo": null,
        "content": "hello"
    }"#;
    let msg = parse_message(good).expect("valid message parses");
    assert_eq!(msg.from, "@chris/impl");

    // Bad version.
    let bad_v = good.replace("\"v\": 1", "\"v\": 2");
    assert!(parse_message(&bad_v).is_err());

    // Bad extension.
    let bad_ext = good.replace("@chris/impl", "@Chris/impl");
    assert!(parse_message(&bad_ext).is_err());

    // Bad callId.
    let bad_call = good.replace("call-abcdef1234", "call-short");
    assert!(parse_message(&bad_call).is_err());
}

#[test]
fn seal_open_round_trip_random_iv() {
    let code = "K7F3-9M2P-XQ4R";
    let channel = channel_from_code(code).unwrap();
    let plaintext = b"round-trip payload \xf0\x9f\x9b\xb0 with bytes";

    let frame = channel.seal(plaintext);
    // iv(12) + tag(16) + ct(len).
    assert_eq!(frame.len(), 12 + 16 + plaintext.len());

    let recovered = channel.open(&frame).unwrap();
    assert_eq!(recovered, plaintext);

    // base64 wire round-trip.
    let b64 = frame_to_b64(&frame);
    let frame2 = frame_from_b64(&b64).unwrap();
    assert_eq!(channel.open(&frame2).unwrap(), plaintext);

    // Tamper → open must fail.
    let mut bad = frame.clone();
    let last = bad.len() - 1;
    bad[last] ^= 0x01;
    assert!(channel.open(&bad).is_err(), "tampered frame must not open");

    // Two seals of the same plaintext differ (random iv).
    let f2 = channel.seal(plaintext);
    assert_ne!(frame, f2, "random iv should make frames differ");
}

#[test]
fn normalize_strips_and_validates() {
    assert_eq!(normalize_pairing_code("k7f3-9m2p-xq4r").unwrap(), "K7F39M2PXQ4R");
    assert_eq!(normalize_pairing_code(" K7F3 9M2P XQ4R ").unwrap(), "K7F39M2PXQ4R");
    assert!(normalize_pairing_code("K7F3-9M2P").is_err(), "too short");
    // 'I','L','O' are not in CODE_ALPHABET → illegal char.
    assert!(normalize_pairing_code("IIII-LLLL-OOOO").is_err());
}

#[test]
fn generated_code_normalizes_and_derives() {
    for _ in 0..50 {
        let code = generate_pairing_code();
        // Shape: 3 groups of 4 joined by '-'.
        assert_eq!(code.len(), 14, "code = {code}");
        assert_eq!(code.matches('-').count(), 2);
        let norm = normalize_pairing_code(&code).expect("generated code normalizes");
        assert_eq!(norm.len(), 12);
        // And it derives a rendezvous id.
        assert_eq!(rendezvous_id(&code).unwrap().len(), 32);
    }
}

#[test]
fn generated_ids_match_validators() {
    for _ in 0..50 {
        assert!(is_valid_message_id(&new_message_id()));
        assert!(is_valid_call_id(&new_call_id()));
    }
}
