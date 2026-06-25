import { EXTENSION_RE } from '@switchboard/protocol';
import type { Extension } from '@switchboard/protocol';

/** Default relay endpoint when `SWITCHBOARD_RELAY_URL` is unset. */
export const DEFAULT_RELAY_URL = 'ws://localhost:8787';

/** Read the relay URL from the environment, falling back to localhost. */
export function relayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SWITCHBOARD_RELAY_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_RELAY_URL;
}

/**
 * Read and validate the local agent's extension from `SWITCHBOARD_EXTENSION`.
 * Throws a friendly, actionable error if it is missing or malformed — this is
 * the non-developer surface, so the message has to tell them exactly what to do.
 */
export function requireExtension(env: NodeJS.ProcessEnv = process.env): Extension {
  const raw = env.SWITCHBOARD_EXTENSION?.trim();
  if (!raw) {
    throw new Error(
      'SWITCHBOARD_EXTENSION is not set. Pick an address for your agent, e.g.\n' +
        "  export SWITCHBOARD_EXTENSION='@you/impl'",
    );
  }
  if (!EXTENSION_RE.test(raw)) {
    throw new Error(
      `SWITCHBOARD_EXTENSION "${raw}" is not a valid extension.\n` +
        "Use lowercase @owner/role, e.g. '@chris/impl' or '@sora/strategy'.",
    );
  }
  return raw;
}
