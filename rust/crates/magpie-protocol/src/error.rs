//! Error type for the protocol crate.

use std::fmt;

/// Errors raised by pairing-code normalization, schema validation, and the
/// AES-GCM seal/open round-trip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// Pairing code did not normalize to the expected length.
    BadCodeLength { expected: usize, got: usize },
    /// Pairing code contained a character outside `CODE_ALPHABET`.
    IllegalCodeChar(char),
    /// A frame was too short to contain `iv ‖ tag ‖ ct`.
    FrameTooShort { got: usize, min: usize },
    /// AES-256-GCM authentication failed (tampered / wrong key).
    Decrypt,
    /// base64 decoding of a wire frame failed.
    Base64,
    /// An invite's relay URL was not a valid `ws://` / `wss://` URL.
    InvalidRelayUrl(String),
    /// A schema field failed validation.
    Validation(String),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::BadCodeLength { expected, got } => {
                write!(f, "pairing code must be {expected} characters (got {got})")
            }
            ProtocolError::IllegalCodeChar(c) => {
                write!(f, "illegal character in pairing code: {c}")
            }
            ProtocolError::FrameTooShort { got, min } => {
                write!(f, "sealed frame too short: got {got} bytes, need >= {min}")
            }
            ProtocolError::Decrypt => write!(f, "AES-256-GCM authentication/decryption failed"),
            ProtocolError::Base64 => write!(f, "invalid base64 frame"),
            ProtocolError::InvalidRelayUrl(u) => {
                write!(f, "invite relay URL must be ws:// or wss:// (got {u:?})")
            }
            ProtocolError::Validation(m) => write!(f, "validation error: {m}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// Convenience result alias.
pub type Result<T> = std::result::Result<T, ProtocolError>;
