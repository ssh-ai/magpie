import { SwitchboardClient } from '@switchboard/client';
import { fenceUntrusted } from '@switchboard/protocol';
import type { Message } from '@switchboard/protocol';

/**
 * Human-facing rendering of an inbound peer message.
 *
 * `listen` exists to surface peer queries to a human (or to a human-supervised
 * agent), so every inbound query is shown FENCED as untrusted data — the same
 * fence the rest of the system uses — with a clear `From <ext>` header.
 */
export function renderInboundForHuman(msg: Message): string {
  const header = `\n📨 ${msg.from} · ${msg.type} · turn ${msg.turn}`;
  return `${header}\n${fenceUntrusted(msg.content)}\n`;
}

/**
 * Wire a connected client's inbound stream to a writer and keep the process
 * alive until the call ends. Resolves when the peer hangs up, the connection
 * closes, or SIGINT is received. Returns the reason the loop ended.
 *
 * This is the shared receive loop behind `start`, `call`, and `listen`: the
 * call lives on THIS process's WebSocket connection (the relay keys calls by
 * socket identity), so the process must stay up to keep the line open.
 */
export function streamUntilDone(
  client: SwitchboardClient,
  out: (line: string) => void,
  opts: { onMessage?: (msg: Message) => void } = {},
): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (reason: string) => {
      if (done) return;
      done = true;
      process.off('SIGINT', onSigint);
      resolve(reason);
    };

    const onSigint = () => finish('you hung up (Ctrl-C)');

    client.onMessage((msg) => {
      out(renderInboundForHuman(msg));
      opts.onMessage?.(msg);
    });
    client.onHangup((reason) => finish(`call ended: ${reason}`));

    process.on('SIGINT', onSigint);
  });
}
