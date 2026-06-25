import { createInterface } from 'node:readline';
import { SwitchboardClient } from '@switchboard/client';
import { fenceUntrusted, newMessageId, PROTOCOL_VERSION } from '@switchboard/protocol';
import type { Extension, Message } from '@switchboard/protocol';

/**
 * Human-facing rendering of an inbound peer message.
 *
 * Every inbound query is shown FENCED as untrusted data — the same fence the
 * rest of the system uses — with a clear `From <ext>` header.
 */
export function renderInboundForHuman(msg: Message): string {
  const header = `\n📨 ${msg.from} · ${msg.type} · turn ${msg.turn}`;
  return `${header}\n${fenceUntrusted(msg.content)}\n`;
}

/** Options for the shared receive/converse loop. */
export interface StreamOpts {
  onMessage?: (msg: Message) => void;
  /**
   * When provided, enable TYPING on this connection: lines read from `input`
   * are sent to the peer as messages on `callId`. Only the long-lived process
   * that holds the call's socket can send (the relay keys calls by socket
   * identity), so sending must happen here, not from a separate command.
   */
  send?:
    | {
        from: Extension;
        callId: string;
        input: NodeJS.ReadableStream;
        /** Known peer extension, or null until the peer joins / first speaks. */
        peer: Extension | null;
      }
    | undefined;
}

/**
 * Wire a connected client's inbound stream to a writer, optionally let the
 * human type replies, and keep the process alive until the call ends. Resolves
 * when the peer hangs up, the connection closes, or SIGINT is received.
 *
 * The call lives on THIS process's WebSocket connection, so the process must
 * stay up to keep the line open.
 */
export function streamUntilDone(
  client: SwitchboardClient,
  out: (line: string) => void,
  opts: StreamOpts = {},
): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    let peer: Extension | null = opts.send?.peer ?? null;
    let turn = 0;
    let rl: ReturnType<typeof createInterface> | undefined;

    const finish = (reason: string) => {
      if (done) return;
      done = true;
      process.off('SIGINT', onSigint);
      rl?.close();
      resolve(reason);
    };
    const onSigint = () => finish('you hung up (Ctrl-C)');

    client.onMessage((msg) => {
      if (!peer) peer = msg.from; // learn who we're talking to from the first inbound
      out(renderInboundForHuman(msg));
      opts.onMessage?.(msg);
    });
    client.onHangup((reason) => finish(`call ended: ${reason}`));
    client.onPeerJoined((_callId, joined) => {
      peer = joined;
      if (opts.send) out(`\n✅ ${joined} patched in. Type a message + Enter to send. (Ctrl-C to hang up)`);
    });

    process.on('SIGINT', onSigint);

    if (opts.send) {
      const s = opts.send;
      rl = createInterface({ input: s.input });
      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        const to = peer;
        if (!to) {
          out('… no agent on the line yet; your message was not sent.');
          return;
        }
        const msg: Message = {
          v: PROTOCOL_VERSION,
          id: newMessageId(),
          callId: s.callId,
          from: s.from,
          to,
          type: 'query',
          ts: new Date().toISOString(),
          turn,
          inReplyTo: null,
          content: text,
        };
        turn += 1;
        client.send(s.callId, msg).catch((e: unknown) => {
          out(`✗ send failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      });
    }
  });
}
