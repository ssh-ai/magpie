import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import type { Extension } from '@switchboard/protocol';

/**
 * A tiny on-disk record of the CURRENT call, so the stateless `hangup`
 * invocation can find the live `start`/`call`/`listen` process and tear it
 * down, and so humans can recover the code if they lose the terminal output.
 *
 * This is metadata only. The pairing CODE is the sole secret here; the relay
 * never sees it, and it lives only on this machine under the user's home dir.
 * It is NOT the end-to-end key (that is derived from the code in-memory).
 */
export interface Session {
  /** Human-shareable pairing code, e.g. `K7F3-9M2P-XQ4R`. */
  code: string;
  /** Relay-assigned id for the call. */
  callId: string;
  /** Topic the call was opened with. */
  topic: string;
  /** This agent's extension. */
  from: Extension;
  /** How this side entered the call. */
  role: 'opener' | 'joiner';
  /** Relay URL the live process is connected to. */
  relayUrl: string;
  /** PID of the long-lived process holding the call open, if one is running. */
  pid: number;
  /** ISO timestamp the session was created. */
  startedAt: string;
}

const dir = (): string => join(homedir(), '.switchboard');
const file = (): string => join(dir(), 'session.json');

/** Persist the active session, replacing any prior one. */
export function writeSession(s: Session): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Read the active session, or null if there is none / it is unreadable. */
export function readSession(): Session | null {
  if (!existsSync(file())) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file(), 'utf8'));
    return isSession(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Remove the active session record. Safe to call when none exists. */
export function clearSession(): void {
  try {
    rmSync(file(), { force: true });
  } catch {
    // best effort
  }
}

function isSession(raw: unknown): raw is Session {
  if (typeof raw !== 'object' || raw === null) return false;
  const s = raw as Record<string, unknown>;
  return (
    typeof s.code === 'string' &&
    typeof s.callId === 'string' &&
    typeof s.topic === 'string' &&
    typeof s.from === 'string' &&
    (s.role === 'opener' || s.role === 'joiner') &&
    typeof s.relayUrl === 'string' &&
    typeof s.pid === 'number' &&
    typeof s.startedAt === 'string'
  );
}
