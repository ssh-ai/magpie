import { CODE_GROUP_LEN } from './constants.js';
import { normalizePairingCode } from './pairing.js';

/**
 * Self-contained invite tokens — zero-config join.
 *
 * Format: `<CODE>@<relay-url>`, e.g. `K7F3-9M2P-XQ4R@ws://192.168.0.13:8787`.
 *
 * The pairing code alone requires the joiner to already know the relay
 * (MAGPIE_RELAY_URL). An invite carries BOTH, so the human shares ONE token
 * and the joiner needs no relay configuration at all. Bare codes (no `@`)
 * remain valid — the relay then comes from the environment as before.
 *
 * The code alphabet contains no `@`, and a relay URL may legally contain `@`
 * (userinfo), so we split at the FIRST `@`.
 */

export interface ParsedInvite {
  /** The pairing code, normalized (uppercase, no dashes) — join-ready. */
  code: string;
  /** Relay URL carried by the invite, or null for a bare code. */
  relayUrl: string | null;
}

/** Validate a relay URL: must parse as a URL with protocol ws: or wss:. */
function validateRelayUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invite relay URL is not a valid URL: ${JSON.stringify(trimmed)}`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(
      `invite relay URL must be ws:// or wss:// (got ${JSON.stringify(url.protocol)})`,
    );
  }
  return trimmed;
}

/**
 * Compose an invite token from a pairing code (any user-tolerant form) and a
 * ws:// or wss:// relay URL. The code is re-rendered in display form
 * (dash-grouped) so the token stays human-transcribable. Throws on a
 * malformed code or a non-ws(s) URL.
 */
export function formatInvite(code: string, relayUrl: string): string {
  const norm = normalizePairingCode(code);
  const display = norm.match(new RegExp(`.{1,${CODE_GROUP_LEN}}`, 'g'))!.join('-');
  return `${display}@${validateRelayUrl(relayUrl)}`;
}

/**
 * True when a relay URL's host is loopback / unroutable (`localhost`,
 * `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `::`) — reachable only from
 * the machine the relay runs on. An invite carrying such a URL joins fine
 * locally but is dead on arrival for a peer on another machine, with no error
 * on the composing side, so callers surface a warning at composition time.
 */
export function isLoopbackRelayUrl(relayUrl: string): boolean {
  let host: string;
  try {
    host = new URL(relayUrl.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '::'
  );
}

/**
 * The human-facing warning for a loopback-relay invite, or null if the URL is
 * fine. One canonical message, mirrored by the Rust twin.
 */
export function loopbackInviteWarning(relayUrl: string): string | null {
  if (!isLoopbackRelayUrl(relayUrl)) return null;
  return (
    `⚠️ this invite's relay (${relayUrl.trim()}) is loopback-only — a peer on ` +
    `another machine cannot reach it. Unless the other agent runs on this same ` +
    `machine, use a LAN/Tailscale/public relay URL (e.g. ws://<your-lan-ip>:8787).`
  );
}

/**
 * Parse an invite OR a bare pairing code.
 *
 * - `K7F3-9M2P-XQ4R@ws://host:8787` → `{ code: 'K7F39M2PXQ4R', relayUrl: 'ws://host:8787' }`
 * - `K7F3-9M2P-XQ4R`                → `{ code: 'K7F39M2PXQ4R', relayUrl: null }`
 *
 * Throws if the code part fails `normalizePairingCode` or the URL part is not
 * a valid ws:// / wss:// URL.
 */
export function parseInvite(input: string): ParsedInvite {
  const trimmed = input.trim();
  const at = trimmed.indexOf('@');
  if (at === -1) {
    return { code: normalizePairingCode(trimmed), relayUrl: null };
  }
  return {
    code: normalizePairingCode(trimmed.slice(0, at)),
    relayUrl: validateRelayUrl(trimmed.slice(at + 1)),
  };
}
