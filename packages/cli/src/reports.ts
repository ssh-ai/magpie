import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import type { CallReport, CallOutcome } from '@magpie/protocol';

/**
 * On-disk store of end-of-call reports under ~/.magpie/calls/. This is the
 * "report on termination" surface: even if a human was away when their agent
 * finished a call, the conclusion + transcript wait here. Files are 0600; the
 * transcript is plaintext-on-this-machine (the user's own side of the call).
 */

const dir = (): string => join(homedir(), '.magpie', 'calls');

/** Persist a report. Returns the file path. */
export function saveReport(r: CallReport): string {
  mkdirSync(dir(), { recursive: true });
  const path = join(dir(), `${r.callId}.json`);
  writeFileSync(path, JSON.stringify(r, null, 2), { encoding: 'utf8', mode: 0o600 });
  return path;
}

/** All saved reports, newest first. */
export function listReports(): CallReport[] {
  if (!existsSync(dir())) return [];
  const out: CallReport[] = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir(), f), 'utf8')) as CallReport);
    } catch {
      // skip unreadable
    }
  }
  return out.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}

/** One report by callId, or null. */
export function readReport(callId: string): CallReport | null {
  const path = join(dir(), `${callId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CallReport;
  } catch {
    return null;
  }
}

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  resolved: '✅ resolved',
  'turn-cap': '⛔ turn cap reached',
  'hung-up': '📴 hung up',
  disconnected: '🔌 disconnected',
};

export function outcomeLabel(o: CallOutcome): string {
  return OUTCOME_LABEL[o] ?? o;
}

/** A human-readable report block printed when a call ends. */
export function renderReport(r: CallReport): string {
  const lines = [
    '',
    '════════════ CALL REPORT ════════════',
    `Topic:   ${r.topic}`,
    `With:    ${r.peer ?? '(unknown)'}`,
    `Outcome: ${outcomeLabel(r.outcome)}`,
  ];
  if (r.summary) {
    lines.push('', 'Summary:', r.summary);
  } else if (r.outcome !== 'resolved') {
    lines.push('', '(ended without a resolution summary)');
  }
  lines.push('', `Turns: ${r.turns}  ·  ${r.startedAt} → ${r.endedAt}`, '═════════════════════════════════════');
  return lines.join('\n');
}
