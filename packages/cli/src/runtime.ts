import { createInterface } from 'node:readline';
import { SwitchboardClient } from '@switchboard/client';
import { fenceUntrusted, newMessageId, PROTOCOL_VERSION } from '@switchboard/protocol';
import type { Extension, Message, CallOutcome } from '@switchboard/protocol';

/**
 * Human-facing rendering of an inbound peer message, fenced as untrusted data.
 */
export function renderInboundForHuman(msg: Message): string {
  const header = `\n📨 ${msg.from} · ${msg.type} · turn ${msg.turn}`;
  return `${header}\n${fenceUntrusted(msg.content)}\n`;
}

/** How the receive loop ended, with the outcome used to build the report. */
export interface StreamResult {
  reason: string;
  outcome: CallOutcome;
}

export interface StreamOpts {
  onMessage?: (msg: Message) => void;
  /** When provided, enable typing replies (and `/resolve`) on this connection. */
  send?:
    | {
        from: Extension;
        callId: string;
        input: NodeJS.ReadableStream;
        peer: Extension | null;
      }
    | undefined;
}

/**
 * Wire a connected client's inbound stream to a writer, optionally let the
 * human type replies / `/resolve <summary>`, and keep the process alive until
 * the call ends. Resolves with the end reason + outcome.
 */
export function streamUntilDone(
  client: SwitchboardClient,
  out: (line: string) => void,
  opts: StreamOpts = {},
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve) => {
    let done = false;
    let resolvedSeen = false;
    let peer: Extension | null = opts.send?.peer ?? null;
    let turn = 0;
    let rl: ReturnType<typeof createInterface> | undefined;

    const finish = (reason: string, outcome: CallOutcome) => {
      if (done) return;
      done = true;
      process.off('SIGINT', onSigint);
      rl?.close();
      resolve({ reason, outcome });
    };
    const onSigint = () => finish('you hung up (Ctrl-C)', 'hung-up');

    client.onMessage((msg) => {
      if (!peer) peer = msg.from;
      out(renderInboundForHuman(msg));
      opts.onMessage?.(msg);
    });

    client.onResolved((_callId, summary) => {
      resolvedSeen = true;
      out(`\n✅ The other agent marked this RESOLVED:\n${summary}\n`);
      finish('peer resolved the call', 'resolved');
    });

    client.onHangup((reason) => {
      const outcome: CallOutcome = resolvedSeen
        ? 'resolved'
        : /turn cap/i.test(reason)
          ? 'turn-cap'
          : /disconnect|reap/i.test(reason)
            ? 'disconnected'
            : 'hung-up';
      finish(`call ended: ${reason}`, outcome);
    });

    client.onPeerJoined((_callId, joined) => {
      peer = joined;
      if (opts.send) {
        out(`\n✅ ${joined} patched in. Type to send · /resolve <summary> to conclude · Ctrl-C to hang up`);
      }
    });

    process.on('SIGINT', onSigint);

    if (opts.send) {
      const s = opts.send;
      rl = createInterface({ input: s.input });
      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;

        // `/resolve <summary>` concludes the call with a summary, then ends it.
        if (text === '/resolve' || text.startsWith('/resolve ')) {
          const summary = text.slice('/resolve'.length).trim() || '(resolved, no summary given)';
          client
            .resolve(s.callId, summary)
            .then(() => finish(`you resolved: ${summary}`, 'resolved'))
            .catch((e: unknown) => out(`✗ resolve failed: ${e instanceof Error ? e.message : String(e)}`));
          return;
        }

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
