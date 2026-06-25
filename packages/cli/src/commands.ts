import { SwitchboardClient } from '@switchboard/client';
import { normalizePairingCode } from '@switchboard/protocol';
import { relayUrl, requireExtension } from './env.js';
import { writeSession, readSession, clearSession } from './store.js';
import { streamUntilDone } from './runtime.js';

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
}

export const consoleIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  env: process.env,
};

/** The shareable invite line a human pastes into chat. */
export function shareLine(code: string): string {
  return `Patch your agent in:  switchboard join ${code}`;
}

/**
 * `start <topic>` — open a call, print the code + a shareable line, then hold
 * the line open and print any inbound queries. Does not block on the peer.
 */
export async function start(topic: string, io: Io = consoleIo): Promise<void> {
  const from = requireExtension(io.env);
  const url = relayUrl(io.env);
  const client = await SwitchboardClient.connect(url);
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

  io.out(`☎️  Switchboard line open for: ${topic}`);
  io.out('');
  io.out(`   Your code:  ${code}`);
  io.out(`   ${shareLine(code)}`);
  io.out('');
  io.out('Waiting on the line… (Ctrl-C to hang up)');

  const reason = await streamUntilDone(client, io.out);
  io.out(`\n${reason}`);
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
  const client = await SwitchboardClient.connect(url);
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
  const reason = await streamUntilDone(client, io.out, {
    onMessage: () => {
      if (!announced) {
        announced = true;
        io.out('✅ Patched through. The agents are talking.');
      }
    },
  });
  io.out(`\n${reason}`);
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
  const client = await SwitchboardClient.connect(url);
  const { callId } = await client.join({ from, code });

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

  io.out('✅ Patched through. You are on the line.');
  io.out('Listening for queries… (Ctrl-C to hang up)');

  const reason = await streamUntilDone(client, io.out);
  io.out(`\n${reason}`);
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
      'No active call to listen to. Start one with `switchboard start "<topic>"`\n' +
        'or join one with `switchboard join <code>`.',
    );
  }
  const url = relayUrl(io.env);
  const client = await SwitchboardClient.connect(url);
  const { callId } = await client.join({ from, code: session.code });

  io.out(`👂 Listening on the line for: ${session.topic}`);
  io.out('Inbound queries appear below, fenced as untrusted data. (Ctrl-C to stop)');

  const reason = await streamUntilDone(client, io.out);
  io.out(`\n${reason}`);
  void callId;
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
    const client = await SwitchboardClient.connect(session.relayUrl);
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
