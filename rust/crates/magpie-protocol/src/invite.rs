//! Self-contained invite tokens — zero-config join.
//!
//! Mirror of `packages/protocol/src/invite.ts`. Format: `<CODE>@<relay-url>`,
//! e.g. `K7F3-9M2P-XQ4R@ws://192.168.0.13:8787`. The invite carries BOTH the
//! pairing code and the relay URL, so the joiner needs no `MAGPIE_RELAY_URL`.
//! Bare codes (no `@`) remain valid — the relay then comes from the
//! environment as before.
//!
//! The code alphabet contains no `@`, and a relay URL may legally contain `@`
//! (userinfo), so we split at the FIRST `@`.

use crate::constants::CODE_GROUP_LEN;
use crate::error::{ProtocolError, Result};
use crate::pairing::normalize_pairing_code;

/// A parsed invite: the normalized pairing code plus an optional relay URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    /// The pairing code, normalized (uppercase, no dashes) — join-ready.
    pub code: String,
    /// Relay URL carried by the invite; `None` for a bare code.
    pub relay_url: Option<String>,
}

/// Validate a relay URL: must be a `ws://` or `wss://` URL with a non-empty,
/// whitespace-free remainder. (The TS reference uses WHATWG `new URL(...)`;
/// this prefix check accepts/rejects the same inputs for the ws/wss space
/// without pulling in a URL crate.)
fn validate_relay_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("ws://")
        .or_else(|| lower.strip_prefix("wss://"));
    match rest {
        Some(r) if !r.is_empty() && !r.chars().any(char::is_whitespace) => Ok(trimmed.to_string()),
        _ => Err(ProtocolError::InvalidRelayUrl(trimmed.to_string())),
    }
}

/// Compose an invite token from a pairing code (any user-tolerant form) and a
/// `ws://`/`wss://` relay URL. The code is re-rendered in display form
/// (dash-grouped) so the token stays human-transcribable. Mirrors `formatInvite`.
pub fn format_invite(code: &str, relay_url: &str) -> Result<String> {
    let norm = normalize_pairing_code(code)?;
    let display = norm
        .chars()
        .collect::<Vec<_>>()
        .chunks(CODE_GROUP_LEN)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-");
    let url = validate_relay_url(relay_url)?;
    Ok(format!("{display}@{url}"))
}

/// Extract the host from a `ws://`/`wss://` URL without a URL crate: take the
/// authority (up to the first `/`, `?`, or `#`), drop userinfo (up to the last
/// `@`), then strip the port / IPv6 brackets.
fn relay_host(relay_url: &str) -> Option<String> {
    let lower = relay_url.trim().to_ascii_lowercase();
    let rest = lower
        .strip_prefix("ws://")
        .or_else(|| lower.strip_prefix("wss://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = match host_port.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next().unwrap_or(""),
        None => host_port.split(':').next().unwrap_or(host_port),
    };
    Some(host.to_string())
}

/// True when a relay URL's host is loopback / unroutable (`localhost`,
/// `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `::`) — reachable only from
/// the machine the relay runs on. An invite carrying such a URL joins fine
/// locally but is dead on arrival for a peer on another machine, with no error
/// on the composing side, so callers surface a warning at composition time.
/// Mirrors `isLoopbackRelayUrl`.
pub fn is_loopback_relay_url(relay_url: &str) -> bool {
    match relay_host(relay_url) {
        Some(host) => {
            host == "localhost"
                || host.ends_with(".localhost")
                || host.starts_with("127.")
                || host == "::1"
                || host == "0.0.0.0"
                || host == "::"
        }
        None => false,
    }
}

/// The human-facing warning for a loopback-relay invite, or `None` if the URL
/// is fine. Mirrors `loopbackInviteWarning` (one canonical message).
pub fn loopback_invite_warning(relay_url: &str) -> Option<String> {
    if !is_loopback_relay_url(relay_url) {
        return None;
    }
    Some(format!(
        "⚠️ this invite's relay ({}) is loopback-only — a peer on another machine \
         cannot reach it. Unless the other agent runs on this same machine, use a \
         LAN/Tailscale/public relay URL (e.g. ws://<your-lan-ip>:8787).",
        relay_url.trim()
    ))
}

/// Parse an invite OR a bare pairing code. Mirrors `parseInvite`.
///
/// - `K7F3-9M2P-XQ4R@ws://host:8787` → code `K7F39M2PXQ4R`, relay `ws://host:8787`
/// - `K7F3-9M2P-XQ4R`                → code `K7F39M2PXQ4R`, relay `None`
///
/// Errors if the code part fails `normalize_pairing_code` or the URL part is
/// not a valid `ws://`/`wss://` URL.
pub fn parse_invite(input: &str) -> Result<Invite> {
    let trimmed = input.trim();
    match trimmed.find('@') {
        None => Ok(Invite {
            code: normalize_pairing_code(trimmed)?,
            relay_url: None,
        }),
        Some(at) => Ok(Invite {
            code: normalize_pairing_code(&trimmed[..at])?,
            relay_url: Some(validate_relay_url(&trimmed[at + 1..])?),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_invite_composes_display_code_and_url() {
        assert_eq!(
            format_invite("K7F3-9M2P-XQ4R", "ws://192.168.0.13:8787").unwrap(),
            "K7F3-9M2P-XQ4R@ws://192.168.0.13:8787"
        );
        // tolerant of a lowercase, dashless code — re-rendered in display form
        assert_eq!(
            format_invite("k7f39m2pxq4r", "wss://relay.example").unwrap(),
            "K7F3-9M2P-XQ4R@wss://relay.example"
        );
    }

    #[test]
    fn format_invite_rejects_bad_scheme_and_bad_code() {
        assert!(matches!(
            format_invite("K7F3-9M2P-XQ4R", "http://host:8787"),
            Err(ProtocolError::InvalidRelayUrl(_))
        ));
        assert!(matches!(
            format_invite("K7F3-9M2P-XQ4R", "not a url"),
            Err(ProtocolError::InvalidRelayUrl(_))
        ));
        assert!(format_invite("too-short", "ws://host:8787").is_err());
    }

    #[test]
    fn parse_invite_splits_full_invite() {
        let inv = parse_invite("K7F3-9M2P-XQ4R@ws://192.168.0.13:8787").unwrap();
        assert_eq!(inv.code, "K7F39M2PXQ4R");
        assert_eq!(inv.relay_url.as_deref(), Some("ws://192.168.0.13:8787"));
    }

    #[test]
    fn parse_invite_keeps_bare_codes_working() {
        let inv = parse_invite("  k7f3 9m2p xq4r ").unwrap();
        assert_eq!(inv.code, "K7F39M2PXQ4R");
        assert_eq!(inv.relay_url, None);
    }

    #[test]
    fn parse_invite_splits_at_first_at_so_userinfo_urls_survive() {
        let inv = parse_invite("K7F3-9M2P-XQ4R@wss://user:pw@relay.example:9000").unwrap();
        assert_eq!(inv.code, "K7F39M2PXQ4R");
        assert_eq!(inv.relay_url.as_deref(), Some("wss://user:pw@relay.example:9000"));
    }

    #[test]
    fn parse_invite_rejects_bad_scheme_empty_url_and_garbage() {
        assert!(matches!(
            parse_invite("K7F3-9M2P-XQ4R@http://host"),
            Err(ProtocolError::InvalidRelayUrl(_))
        ));
        assert!(matches!(
            parse_invite("K7F3-9M2P-XQ4R@"),
            Err(ProtocolError::InvalidRelayUrl(_))
        ));
        assert!(matches!(
            parse_invite("K7F3-9M2P-XQ4R@ws://"),
            Err(ProtocolError::InvalidRelayUrl(_))
        ));
        assert!(parse_invite("@ws://host:8787").is_err()); // empty code part
        assert!(parse_invite("total garbage").is_err());
    }

    #[test]
    fn flags_loopback_relay_urls() {
        for url in [
            "ws://localhost:8787",
            "ws://relay.localhost:8787",
            "ws://127.0.0.1:8787",
            "ws://127.9.9.9:8787",
            "ws://[::1]:8787",
            "ws://0.0.0.0:8787",
        ] {
            assert!(is_loopback_relay_url(url), "{url}");
            assert!(
                loopback_invite_warning(url).unwrap().contains("loopback-only"),
                "{url}"
            );
        }
    }

    #[test]
    fn does_not_flag_reachable_relay_urls_and_never_panics_on_garbage() {
        for url in [
            "ws://192.168.0.13:8787",
            "wss://relay.example",
            "wss://user:pw@relay.example:9000",
            "ws://100.64.1.5:8787", // Tailscale CGNAT range
        ] {
            assert!(!is_loopback_relay_url(url), "{url}");
            assert!(loopback_invite_warning(url).is_none(), "{url}");
        }
        assert!(!is_loopback_relay_url("not a url"));
    }

    #[test]
    fn round_trips_losslessly() {
        let code = crate::pairing::generate_pairing_code();
        let url = "ws://10.0.0.7:8787";
        let inv = parse_invite(&format_invite(&code, url).unwrap()).unwrap();
        assert_eq!(inv.code, normalize_pairing_code(&code).unwrap());
        assert_eq!(inv.relay_url.as_deref(), Some(url));
    }
}
