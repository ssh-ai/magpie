//! Environment configuration.
//!
//! Mirror of `env.ts`. Two inputs, both from the process environment:
//!   - `MAGPIE_RELAY_URL` — where the relay lives (default localhost).
//!   - `MAGPIE_EXTENSION` — this agent's `@owner/role` address.
//!
//! The `*_from` variants take the raw value explicitly so they can be unit
//! tested without mutating the (process-global, test-racing) environment —
//! the same way `cli.test.ts` passes an `env` object.

use magpie_protocol::is_valid_extension;

/// Default relay endpoint when `MAGPIE_RELAY_URL` is unset.
pub const DEFAULT_RELAY_URL: &str = "ws://localhost:8787";

/// Read the relay URL from the environment, falling back to localhost.
pub fn relay_url() -> String {
    relay_url_from(std::env::var("MAGPIE_RELAY_URL").ok().as_deref())
}

/// Pure core of [`relay_url`]: trim, and fall back to the default when blank.
pub fn relay_url_from(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => DEFAULT_RELAY_URL.to_string(),
    }
}

/// Read and validate the local agent's extension from `MAGPIE_EXTENSION`.
/// Returns a friendly, actionable error string on missing/malformed input —
/// this is the non-developer surface, so the message says exactly what to do.
pub fn require_extension() -> Result<String, String> {
    require_extension_from(std::env::var("MAGPIE_EXTENSION").ok().as_deref())
}

/// Pure core of [`require_extension`].
pub fn require_extension_from(raw: Option<&str>) -> Result<String, String> {
    let raw = raw.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return Err("MAGPIE_EXTENSION is not set. Pick an address for your agent, e.g.\n  \
             export MAGPIE_EXTENSION='@you/impl'"
            .to_string());
    }
    if !is_valid_extension(raw) {
        return Err(format!(
            "MAGPIE_EXTENSION \"{raw}\" is not a valid extension.\n\
             Use lowercase @owner/role, e.g. '@chris/impl' or '@sora/strategy'."
        ));
    }
    Ok(raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_url_defaults_when_unset_or_blank() {
        assert_eq!(relay_url_from(None), DEFAULT_RELAY_URL);
        assert_eq!(relay_url_from(Some("   ")), DEFAULT_RELAY_URL);
        assert_eq!(relay_url_from(Some("")), DEFAULT_RELAY_URL);
    }

    #[test]
    fn relay_url_honors_explicit_value_trimmed() {
        assert_eq!(
            relay_url_from(Some(" wss://relay.example:9000 ")),
            "wss://relay.example:9000"
        );
    }

    #[test]
    fn require_extension_returns_valid() {
        assert_eq!(require_extension_from(Some("@chris/impl")).unwrap(), "@chris/impl");
        // Surrounding whitespace is trimmed.
        assert_eq!(require_extension_from(Some("  @sora/strategy ")).unwrap(), "@sora/strategy");
    }

    #[test]
    fn require_extension_friendly_error_when_missing() {
        let err = require_extension_from(None).unwrap_err();
        assert!(err.contains("MAGPIE_EXTENSION is not set"));
        let err = require_extension_from(Some("   ")).unwrap_err();
        assert!(err.contains("MAGPIE_EXTENSION is not set"));
    }

    #[test]
    fn require_extension_rejects_malformed() {
        // Bare word, no @owner/role.
        assert!(require_extension_from(Some("chris"))
            .unwrap_err()
            .contains("not a valid extension"));
        // Uppercase is not allowed.
        assert!(require_extension_from(Some("@Chris/Impl"))
            .unwrap_err()
            .contains("not a valid extension"));
    }
}
