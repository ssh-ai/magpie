/**
 * In-process conformance harness.
 *
 * Spins up a real @magpie/relay (ephemeral port, real WebSockets) and as
 * many @magpie/client endpoints as a scenario needs. Everything runs in
 * one process so the suite is hermetic and fast, yet exercises the genuine
 * seal/route/open path end-to-end — the relay still only ever sees ciphertext.
 *
 * The helpers below give scenarios deterministic, promise-based waits for the
 * next inbound message / hangup, which is what makes porting the prior-art
 * (claude-code-session-bridge) request/response scripts straightforward.
 */
import { startRelay } from '@magpie/relay';
import type { RelayHandle, RelayOptions } from '@magpie/relay';
import { MagpieClient } from '@magpie/client';
import {
  newMessageId,
  newCallId,
  PROTOCOL_VERSION,
} from '@magpie/protocol';
import type { Extension, Message, MessageType } from '@magpie/protocol';

/** A connected endpoint plus inbound queues + waiters for deterministic asserts. */
export interface Endpoint {
  readonly client: MagpieClient;
  /** Every decrypted inbound Message, in arrival order. */
  readonly inbox: Message[];
  /** Every hangup reason seen, in arrival order. */
  readonly hangups: string[];
  /** Resolve once the Nth (1-based) inbound message has arrived. */
  waitForMessage(n?: number): Promise<Message>;
  /** Resolve once a hangup reaches this endpoint. */
  waitForHangup(): Promise<string>;
}

/** The whole rig: a relay and any endpoints a scenario opened. */
export interface Harness {
  readonly relay: RelayHandle;
  readonly url: string;
  /** Connect a fresh endpoint to the relay. */
  endpoint(): Promise<Endpoint>;
  /** Tear everything down: close clients, then the relay. */
  dispose(): Promise<void>;
}

/** Boot a relay on an ephemeral port and return a harness bound to it. */
export async function makeHarness(opts: RelayOptions = {}): Promise<Harness> {
  const relay = await startRelay(0, opts);
  const url = `ws://127.0.0.1:${relay.port}`;
  const endpoints: MagpieClient[] = [];

  return {
    relay,
    url,
    async endpoint(): Promise<Endpoint> {
      const client = await MagpieClient.connect(url);
      endpoints.push(client);
      return wrapEndpoint(client);
    },
    async dispose(): Promise<void> {
      for (const c of endpoints.splice(0)) {
        try {
          c.close();
        } catch {
          /* already closed */
        }
      }
      await relay.close();
    },
  };
}

function wrapEndpoint(client: MagpieClient): Endpoint {
  const inbox: Message[] = [];
  const hangups: string[] = [];
  const msgWaiters: Array<{ n: number; resolve: (m: Message) => void }> = [];
  const hangupWaiters: Array<(r: string) => void> = [];

  client.onMessage((msg) => {
    inbox.push(msg);
    for (let i = msgWaiters.length - 1; i >= 0; i--) {
      const w = msgWaiters[i]!;
      if (inbox.length >= w.n) {
        msgWaiters.splice(i, 1);
        w.resolve(inbox[w.n - 1]!);
      }
    }
  });

  client.onHangup((reason) => {
    hangups.push(reason);
    for (const w of hangupWaiters.splice(0)) w(reason);
  });

  return {
    client,
    inbox,
    hangups,
    waitForMessage(n = 1): Promise<Message> {
      if (inbox.length >= n) return Promise.resolve(inbox[n - 1]!);
      return new Promise((resolve) => msgWaiters.push({ n, resolve }));
    },
    waitForHangup(): Promise<string> {
      if (hangups.length > 0) return Promise.resolve(hangups[0]!);
      return new Promise((resolve) => hangupWaiters.push(resolve));
    },
  };
}

/**
 * Build a well-formed wire Message. Scenarios override only the fields they
 * care about; everything else defaults to a valid value so parseMessage passes.
 */
export function makeMessage(
  fields: {
    callId: string;
    from: Extension;
    to: Extension;
    type?: MessageType;
    content: string;
    turn?: number;
    inReplyTo?: string | null;
  },
): Message {
  return {
    v: PROTOCOL_VERSION,
    id: newMessageId(),
    callId: fields.callId,
    from: fields.from,
    to: fields.to,
    type: fields.type ?? 'query',
    ts: new Date().toISOString(),
    turn: fields.turn ?? 0,
    inReplyTo: fields.inReplyTo ?? null,
    content: fields.content,
  };
}

/** Convenience addresses used across the corpus (mirrors prior-art two-party calls). */
export const ALICE: Extension = '@chris/impl';
export const BOB: Extension = '@sora/strategy';
export const CAROL: Extension = '@dana/review';

/** Re-export id mint helpers so scenarios don't reach past the harness. */
export { newMessageId, newCallId };
