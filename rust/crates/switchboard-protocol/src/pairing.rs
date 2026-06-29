//! Pairing & the end-to-end channel.
//!
//! Mirror of `packages/protocol/src/pairing.ts`. The pairing code is the only
//! secret the two humans share over their own side channel. The relay never
//! sees the code — only a salted `rendezvous_id` derived from it. The code
//! (~59 bits) is stretched via HKDF-SHA256 into an AES-256-GCM channel key.
//!
//! Byte-for-byte compatibility with the TS reference is REQUIRED: a Rust client
//! and a TS client must derive the same rendezvous id, the same channel key,
//! and must be able to open each other's sealed frames. This is enforced by
//! the cross-impl crypto vectors in `tests/`.

use aes_gcm::aead::AeadInPlace;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

use crate::constants::{CODE_ALPHABET, CODE_GROUP_LEN, CODE_TOTAL_LEN};
use crate::error::{ProtocolError, Result};

const RENDEZVOUS_INFO: &[u8] = b"switchboard:rendezvous:v1";
const CHANNEL_INFO: &[u8] = b"switchboard:channel:v1";

/// IV length for AES-256-GCM (96-bit nonce, the GCM standard).
const IV_LEN: usize = 12;
/// Authentication-tag length for AES-256-GCM.
const TAG_LEN: usize = 16;

/// Normalize user input (uppercase, strip anything outside `[A-Z0-9]`) and
/// validate shape. Mirrors `normalizePairingCode`.
///
/// Returns the normalized 12-char code or a `ProtocolError`.
pub fn normalize_pairing_code(input: &str) -> Result<String> {
    let cleaned: String = input
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .collect();

    if cleaned.len() != CODE_TOTAL_LEN {
        return Err(ProtocolError::BadCodeLength {
            expected: CODE_TOTAL_LEN,
            got: cleaned.len(),
        });
    }
    for ch in cleaned.chars() {
        if !CODE_ALPHABET.contains(ch) {
            return Err(ProtocolError::IllegalCodeChar(ch));
        }
    }
    Ok(cleaned)
}

/// HKDF-SHA256 with an EMPTY salt (equivalent to RFC-5869's HashLen-zeros salt
/// after HMAC zero-padding — matches Node's `Buffer.alloc(0)`).
fn hkdf_expand(ikm: &[u8], info: &[u8], out: &mut [u8]) {
    let hk = Hkdf::<Sha256>::new(Some(&[]), ikm);
    hk.expand(info, out)
        .expect("HKDF expand: output length within 255*HashLen");
}

/// Rendezvous id the relay uses to pair two endpoints WITHOUT learning the code.
/// `HKDF-SHA256(ikm=utf8(norm), salt="", info="switchboard:rendezvous:v1", L=16)`
/// rendered as lowercase hex (32 chars). Mirrors `rendezvousId`.
pub fn rendezvous_id(code: &str) -> Result<String> {
    let norm = normalize_pairing_code(code)?;
    let mut out = [0u8; 16];
    hkdf_expand(norm.as_bytes(), RENDEZVOUS_INFO, &mut out);
    Ok(hex::encode(out))
}

/// Derive the raw 32-byte AES-256 channel key from a code.
/// `HKDF-SHA256(ikm=utf8(norm), salt="", info="switchboard:channel:v1", L=32)`.
pub fn channel_key(code: &str) -> Result<[u8; 32]> {
    let norm = normalize_pairing_code(code)?;
    let mut key = [0u8; 32];
    hkdf_expand(norm.as_bytes(), CHANNEL_INFO, &mut key);
    Ok(key)
}

/// The swappable channel seam (MVP: HKDF→AES-256-GCM). PAKE impl drops in later.
/// Mirrors the `PairingChannel` interface + `HkdfGcmChannel`.
pub struct PairingChannel {
    cipher: Aes256Gcm,
}

impl PairingChannel {
    /// Build a channel from a 32-byte key.
    pub fn from_key(key: &[u8; 32]) -> Self {
        let cipher = Aes256Gcm::new(key.into());
        PairingChannel { cipher }
    }

    /// Seal plaintext with a RANDOM 12-byte IV. Frame layout: `iv ‖ tag ‖ ct`.
    pub fn seal(&self, plaintext: &[u8]) -> Vec<u8> {
        let mut iv = [0u8; IV_LEN];
        rand::thread_rng().fill_bytes(&mut iv);
        self.seal_with_iv(&iv, plaintext)
    }

    /// Seal with a caller-supplied IV (used by the cross-impl ENCRYPT vector).
    /// AES-256-GCM, no AAD, DETACHED tag → exact `iv ‖ tag ‖ ct` layout.
    pub fn seal_with_iv(&self, iv: &[u8; IV_LEN], plaintext: &[u8]) -> Vec<u8> {
        let nonce = Nonce::from_slice(iv);
        let mut buf = plaintext.to_vec();
        let tag = self
            .cipher
            .encrypt_in_place_detached(nonce, b"", &mut buf)
            .expect("AES-256-GCM encryption is infallible for in-memory buffers");
        let mut frame = Vec::with_capacity(IV_LEN + TAG_LEN + buf.len());
        frame.extend_from_slice(iv);
        frame.extend_from_slice(tag.as_slice());
        frame.extend_from_slice(&buf);
        frame
    }

    /// Open a frame: split `iv=[0:12]`, `tag=[12:28]`, `ct=[28:]`; verify+decrypt.
    pub fn open(&self, frame: &[u8]) -> Result<Vec<u8>> {
        let min = IV_LEN + TAG_LEN;
        if frame.len() < min {
            return Err(ProtocolError::FrameTooShort {
                got: frame.len(),
                min,
            });
        }
        let nonce = Nonce::from_slice(&frame[0..IV_LEN]);
        let tag = aes_gcm::Tag::from_slice(&frame[IV_LEN..min]);
        let mut buf = frame[min..].to_vec();
        self.cipher
            .decrypt_in_place_detached(nonce, b"", &mut buf, tag)
            .map_err(|_| ProtocolError::Decrypt)?;
        Ok(buf)
    }
}

/// Derive the E2E channel from a pairing code (MVP: HKDF→AES-256-GCM).
/// Mirrors `channelFromCode`.
pub fn channel_from_code(code: &str) -> Result<PairingChannel> {
    let key = channel_key(code)?;
    Ok(PairingChannel::from_key(&key))
}

/// Encode a sealed frame to the base64 wire form (standard alphabet, padded —
/// matches Node's `Buffer.toString('base64')`).
pub fn frame_to_b64(frame: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(frame)
}

/// Decode a base64 wire frame. Accepts padded or unpadded standard base64.
pub fn frame_from_b64(b64: &str) -> Result<Vec<u8>> {
    // STANDARD requires correct padding; fall back to no-pad for robustness.
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64))
        .map_err(|_| ProtocolError::Base64)
}

/// Generate a fresh pairing code, e.g. `K7F3-9M2P-XQ4R`. Mirrors
/// `generatePairingCode` (uniform over `CODE_ALPHABET` via rejection-free
/// modulo of random bytes — same construction as the TS reference).
pub fn generate_pairing_code() -> String {
    let alphabet: Vec<char> = CODE_ALPHABET.chars().collect();
    let mut bytes = vec![0u8; CODE_TOTAL_LEN];
    rand::thread_rng().fill_bytes(&mut bytes);

    let mut chars: Vec<char> = Vec::with_capacity(CODE_TOTAL_LEN);
    for b in &bytes {
        chars.push(alphabet[(*b as usize) % alphabet.len()]);
    }

    chars
        .chunks(CODE_GROUP_LEN)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}
