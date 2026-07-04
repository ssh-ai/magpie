import { MagpieClient } from '@magpie/client';
import { normalizePairingCode } from '@magpie/protocol';
import { relayUrl, requireExtension } from './env.js';
import { writeSession, readSession, clearSession } from './store.js';
import { streamUntilDone } from './runtime.js';
import type { StreamResult } from './runtime.js';
import { saveReport, renderReport, listReports, readReport, outcomeLabel } from './reports.js';

/**
 * Print the end reason, then build + show + persist the call report. This is
 * the "report on termination" the async value proposition depends on: the
 * conclusion + transcript are saved to ~/.magpie/calls/ so an away human
 * can read them later with `magpie report`.
 */
function finishCall(
  client: MagpieClient,
  callId: string,
  result: StreamResult,
  io: Io,
): void {
  io.out(`\n${result.reason}`);
  const report = client.buildReport(callId, result.outcome);
  if (report) {
    io.out(renderReport(report));
    try {
      const path = saveReport(report);
      io.out(`📋 Report saved: ${path}  (re-read with: magpie report ${report.callId})`);
    } catch (err) {
      io.err(`(could not save report: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

/**
 * The command handlers. Each is small and friendly: this is the
 * non-developer-simple surface, so output is minimal and reads like a phone
 * call, not a stack trace.
 *
 * IMPORTANT — process model: a call lives on the WebSocket connection that
 * opened or joined it (the relay keys calls by socket identity). So `start`,
 * `call`, and `listen` are LONG-LIVED: they hold the line open and stream
 * inbound queries until hangup. `join` patches in and then streams. `hangup`
 * is the only one-shot command — it signals the live process to drop the line.
 */

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Line source for typing replies. Present on the real CLI; omitted in tests. */
  input?: NodeJS.ReadableStream;
}

export const consoleIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  env: process.env,
  input: process.stdin,
};

/** The shareable invite line a human pastes into chat. */
export function shareLine(code: string): string {
  return `Patch your agent in:  magpie join ${code}`;
}

/**
 * `start <topic>` — open a call, print the code + a shareable line, then hold
 * the line open and print any inbound queries. Does not block on the peer.
 */
export async function start(topic: string, io: Io = consoleIo): Promise<void> {
  const from = requireExtension(io.env);
  const url = relayUrl(io.env);
  const client = await MagpieClient.connect(url);
  const { code, callId } = await client.start({ from, topic });

  writeSession({
    code,
    callId,
    topic,
    from,
    role: 'opener',
    relayUrl: url,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  io.out(`☎️  Magpie line open for: ${topic}`);
  io.out('');
  io.out(`   Your code:  ${code}`);
  io.out(`   ${shareLine(code)}`);
  io.out('');
  io.out('Waiting on the line… (Ctrl-C to hang up)');

  const result = await streamUntilDone(client, io.out, {
    send: io.input ? { from, callId, input: io.input, peer: null } : undefined,
  });
  finishCall(client, callId, result, io);
  clearSession();
  client.close();
}

/**
 * `call <topic>` — like `start`, but waits for the peer to actually join before
 * announcing "patched through", then streams inbound queries.
 */
export async function call(topic: string, io: Io = consoleIo): Promise<void> {
  const from = requireExtension(io.env);
  const url = relayUrl(io.env);
  const client = await MagpieClient.connect(url);
  const { code, callId } = await client.start({ from, topic });

  writeSession({
    code,
    callId,
    topic,
    from,
    role: 'opener',
    relayUrl: url,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  io.out(`☎️  Calling about: ${topic}`);
  io.out('');
  io.out(`   Your code:  ${code}`);
  io.out(`   ${shareLine(code)}`);
  io.out('');
  io.out('Ringing… waiting for the other agent to pick up. (Ctrl-C to cancel)');

  // The client surfaces the peer joining via a message stream; the very first
  // inbound activity OR an explicit peer-joined is our "picked up" signal. We
  // print "patched through" on the first message and then keep streaming.
  let announced = false;
  const result = await streamUntilDone(client, io.out, {
    send: io.input ? { from, callId, input: io.input, peer: null } : undefined,
    onMessage: () => {
      if (!announced) {
        announced = true;
        io.out('✅ Patched through. The agents are talking.');
      }
    },
  });
  finishCall(client, callId, result, io);
  clearSession();
  client.close();
}

/**
 * `join <code>` — patch your agent into an existing call using a code shared
 * over chat, then hold the line and stream inbound queries.
 */
export async function join(rawCode: string, io: Io = consoleIo): Promise<void> {
  const from = requireExtension(io.env);
  const url = relayUrl(io.env);
  const code = normalizePairingCode(rawCode); // throws a friendly error on bad shape
  const client = await MagpieClient.connect(url);
  const { callId, peer } = await client.join({ from, code });

  writeSession({
    code,
    callId,
    topic: '(joined)',
    from,
    role: 'joiner',
    relayUrl: url,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  io.out(`✅ Patched through to ${peer}. You are on the line.`);
  io.out('Type a message + Enter to send; inbound queries appear below. (Ctrl-C to hang up)');

  const result = await streamUntilDone(client, io.out, {
    send: io.input ? { from, callId, input: io.input, peer } : undefined,
  });
  finishCall(client, callId, result, io);
  clearSession();
  client.close();
}

/**
 * `listen` — resume the active call (from the stored code) and print inbound
 * fenced queries. Use this when you started a call in another way and just
 * want to watch the line. It re-patches in as a participant using the stored
 * pairing code.
 */
export async function listen(io: Io = consoleIo): Promise<void> {
  const from = requireExtension(io.env);
  const session = readSession();
  if (!session) {
    throw new Error(
      'No active call to listen to. Start one with `magpie start "<topic>"`\n' +
        'or join one with `magpie join <code>`.',
    );
  }
  const url = relayUrl(io.env);
  const client = await MagpieClient.connect(url);
  const { callId } = await client.join({ from, code: session.code });

  io.out(`👂 Listening on the line for: ${session.topic}`);
  io.out('Inbound queries appear below, fenced as untrusted data. (Ctrl-C to stop)');

  const result = await streamUntilDone(client, io.out);
  finishCall(client, callId, result, io);
  client.close();
}

/**
 * `hangup` — drop the active call. Tells the relay (via a fresh connection on
 * the stored call) and signals the live `start`/`call`/`listen` process to
 * exit if one is running, then clears the stored session.
 */
export async function hangup(io: Io = consoleIo): Promise<void> {
  const session = readSession();
  if (!session) {
    io.out('Nothing to hang up — no active call.');
    return;
  }

  // Best effort: ask the relay to close the call so the peer is notified.
  try {
    const client = await MagpieClient.connect(session.relayUrl);
    await client.hangup(session.callId);
    client.close();
  } catch {
    // Relay unreachable; we still tear down locally below.
  }

  // Signal the long-lived process (if it is ours and still alive) to exit.
  if (session.pid && session.pid !== process.pid) {
    try {
      process.kill(session.pid, 'SIGINT');
    } catch {
      // process already gone
    }
  }

  clearSession();
  io.out('📴 Hung up.');
}

/**
 * `history` — list past calls and their outcomes (from ~/.magpie/calls/).
 * This is how an away human catches up on what their agent concluded.
 */
export async function history(io: Io = consoleIo): Promise<void> {
  const reports = listReports();
  if (reports.length === 0) {
    io.out('No past calls yet.');
    return;
  }
  io.out(`Past calls (${reports.length}):`);
  for (const r of reports) {
    io.out(`  ${r.endedAt}  ${outcomeLabel(r.outcome)}  with ${r.peer ?? '?'}  "${r.topic}"`);
    io.out(`      magpie report ${r.callId}`);
  }
}

/**
 * `report [callId]` — show a past call's report + full transcript. Defaults to
 * the most recent call.
 */
export async function showReport(callId: string | undefined, io: Io = consoleIo): Promise<void> {
  const report = callId ? readReport(callId) : listReports()[0];
  if (!report) {
    io.out(callId ? `No report for call ${callId}.` : 'No past calls yet.');
    return;
  }
  io.out(renderReport(report));
  io.out('\n──── transcript ────');
  if (report.transcript.length === 0) {
    io.out('(no messages)');
  }
  for (const e of report.transcript) {
    io.out(`[${e.type}] ${e.from}: ${e.content}`);
  }
}
