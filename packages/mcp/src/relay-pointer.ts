/**
 * Default-relay resolution via a STABLE POINTER.
 *
 * The hosted default relay's address is NOT baked into the binary. Instead the
 * MCP resolves it at startup from a small text file served at a permanent URL
 * (GitHub Pages). Migrating the relay (spare laptop → cloud box, or a tunnel
 * URL that changed) is then a ONE-LINE edit to that file — no re-release, no
 * client reconfiguration. The relay only ever sees end-to-end-encrypted
 * ciphertext, so trusting an HTTPS-fetched address introduces no new exposure.
 *
 * Resolution precedence:
 *   1. `MAGPIE_RELAY_URL`  — explicit override (self-host / pinning). Wins; no fetch.
 *   2. the pointer file    — the hosted default (this module).
 *   3. null                — invite-carried URLs only (joiners paste `CODE@ws://…`).
 *
 * Set `MAGPIE_RELAY_POINTER=''` (empty) to disable the fetch entirely.
 */

/** The permanent pointer URL. Its CONTENTS change; this address never does. */
export const DEFAULT_RELAY_POINTER = 'https://ssh-ai.github.io/magpie/relay.txt';

/** How long to wait on the pointer fetch before falling back to invite-only. */
const FETCH_TIMEOUT_MS = 4000;

/**
 * Extract the relay URL from a `relay.txt` body: the first non-empty,
 * non-comment (`#`) line that is a valid `ws://`/`wss://` URL. Returns null if
 * there is no such line (an as-yet-unconfigured pointer) or the first content
 * line is malformed (surfaced as invite-only rather than a bad connection).
 */
export function parseRelayPointer(body: string): string | null {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    try {
      const url = new URL(line);
      if (url.protocol === 'ws:' || url.protocol === 'wss:') return line;
    } catch {
      /* fall through to null */
    }
    return null; // first content line was not a valid ws(s) URL
  }
  return null;
}

export interface ResolveOpts {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the pointer URL (else env `MAGPIE_RELAY_POINTER` or the default). */
  pointerUrl?: string;
  /** Diagnostics sink (stderr in production). */
  warn?: (msg: string) => void;
}

/**
 * Resolve the default relay URL. `MAGPIE_RELAY_URL` wins outright; otherwise the
 * pointer file is fetched. Any failure (offline, 404, malformed, timeout)
 * resolves to null — the agent then works in invite-only mode instead of
 * crashing. Never throws.
 */
export async function resolveDefaultRelay(
  env: NodeJS.ProcessEnv,
  opts: ResolveOpts = {},
): Promise<string | null> {
  const explicit = env.MAGPIE_RELAY_URL?.trim();
  if (explicit) return explicit;

  // An explicitly-empty pointer env disables the hosted default.
  const pointerRaw = env.MAGPIE_RELAY_POINTER;
  if (pointerRaw !== undefined && pointerRaw.trim() === '') return null;
  const pointerUrl = opts.pointerUrl ?? pointerRaw?.trim() ?? DEFAULT_RELAY_POINTER;

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(pointerUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) {
      opts.warn?.(`relay pointer ${pointerUrl} returned HTTP ${res.status}`);
      return null;
    }
    const url = parseRelayPointer(await res.text());
    if (!url) opts.warn?.(`relay pointer ${pointerUrl} has no usable ws(s):// URL yet`);
    return url;
  } catch (err) {
    opts.warn?.(
      `could not fetch relay pointer ${pointerUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
