import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';

/**
 * Dead-simple presence for the hybrid attendant: a live session marks itself
 * "on duty" for a handle by touching a duty file (and re-touching periodically
 * as a heartbeat). The attendant's {@link AutoAttendant.isLive} reads it: fresh
 * file ⇒ a live session is answering; stale/absent ⇒ fall back to files.
 *
 * No daemon, no IPC — just an mtime check under ~/.magpie/duty/.
 */

const dutyDir = (): string => join(homedir(), '.magpie', 'duty');

function dutyFile(handle: string): string {
  // Encode so a handle like "@chris/agbot" is a safe single filename.
  return join(dutyDir(), encodeURIComponent(handle));
}

/** Mark (or refresh) this handle as on-duty. Call on a heartbeat while live. */
export function goOnDuty(handle: string): void {
  mkdirSync(dutyDir(), { recursive: true });
  // Writing refreshes the file's mtime — that mtime IS the heartbeat.
  writeFileSync(dutyFile(handle), 'on-duty', { encoding: 'utf8', mode: 0o600 });
}

/**
 * Build an `isLive` check for {@link AutoAttendantOptions.isLive}: returns true
 * iff the handle's duty file was refreshed within `maxAgeMs`. (maxAgeMs <= 0
 * means "never live".)
 */
export function dutyPresence(handle: string, maxAgeMs = 30_000): () => boolean {
  const file = dutyFile(handle);
  return () => {
    try {
      if (!existsSync(file)) return false;
      const ageMs = Math.max(0, Date.now() - statSync(file).mtimeMs);
      return ageMs < maxAgeMs;
    } catch {
      return false;
    }
  };
}
