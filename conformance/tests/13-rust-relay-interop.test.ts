import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SwitchboardClient } from '@switchboard/client';
import { generatePairingCode } from '@switchboard/protocol';
import type { Extension, Message } from '@switchboard/protocol';
import { makeMessage, ALICE, BOB, CAROL } from '../src/harness.js';

/**
 * PHASE 1 — gate 3: cross-impl conformance parity.
 *
 * The same behavioral corpus the in-process TS relay passes (scenarios 01/03/04/
 * 05/10 + the turn cap) is run here against the REAL Rust relay BINARY, driven
 * through the genuine TS SwitchboardClient + protocol crypto. The relay only
 * ever brokers ciphertext; this proves the Rust port is wire-identical and a
 * drop-in for the TS relay.
 *
 * The relay is spawned once on an ephemeral port (SWITCHBOARD_RELAY_PORT=0) and
 * shared across scenarios; each scenario opens fresh endpoints and tears them
 * down in afterEach, so calls never bleed across tests.
 */

const BIN = fileURLToPath(
  new URL('../../rust/target/debug/switchboard-relay', import.meta.url),
);
const MANIFEST = fileURLToPath(new URL('../../rust/Cargo.toml', import.meta.url));

/** A connected endpoint + inbound queues/waiters (mirrors src/harness wrapEndpoint). */
interface Ep {
  readonly client: SwitchboardClient;
  readonly inbox: Message[];
  readonly hangups: string[];
  waitForMessage(n?: number): Promise<Message>;
  waitForHangup(): Promise<string>;
}

let relay: ChildProcess | undefined;
let url = '';
let live: SwitchboardClient[] = [];

function wrap(client: SwitchboardClient): Ep {
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
    waitForMessage(n = 1) {
      if (inbox.length >= n) return Promise.resolve(inbox[n - 1]!);
      return new Promise((resolve) => msgWaiters.push({ n, resolve }));
    },
    waitForHangup() {
      if (hangups.length > 0) return Promise.resolve(hangups[0]!);
      return new Promise((resolve) => hangupWaiters.push(resolve));
    },
  };
}

async function endpoint(): Promise<Ep> {
  const client = await SwitchboardClient.connect(url);
  live.push(client);
  return wrap(client);
}

beforeAll(async () => {
  // Self-sufficient: build the relay binary if a prior `cargo build` didn't.
  if (!existsSync(BIN)) {
    execSync(`cargo build --manifest-path "${MANIFEST}"`, { stdio: 'inherit' });
  }
  relay = spawn(BIN, [], {
    env: {
      ...process.env,
      SWITCHBOARD_RELAY_PORT: '0',
      SWITCHBOARD_RELAY_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('Rust relay never announced listening:\n' + buf)),
      8000,
    );
    relay!.stderr!.on('data', (d) => {
      buf += d;
      const m = /ws:\/\/(127\.0\.0\.1:\d+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(`ws://${m[1]}`);
      }
    });
    relay!.on('exit', (c) => {
      clearTimeout(t);
      reject(new Error(`Rust relay exited early (code ${c}):\n${buf}`));
    });
  });
}, 60_000);

afterEach(() => {
  for (const c of live.splice(0)) {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }
});

afterAll(() => {
  relay?.kill('SIGKILL');
});

describe('conformance/13 Rust relay interop (binary, via TS client)', () => {
  // Scenario 01 — happy-path query/response round trip.
  it('delivers a query to the peer and the response back to the asker', async () => {
    const alice = await endpoint();
    const bob = await endpoint();

    const { code, callId } = await alice.client.start({
      from: ALICE,
      topic: 'what does the auth module export?',
      maxTurns: 6,
    });
    const joined = await bob.client.join({ from: BOB, code });
    expect(joined.callId).toBe(callId);
    expect(joined.callId).toMatch(/^call-/);
    expect(joined.peer).toBe(ALICE);

    const query = makeMessage({
      callId,
      from: ALICE,
      to: BOB,
      type: 'query',
      content: 'Which functions does src/auth.ts export?',
    });
    await alice.client.send(callId, query);

    const got = await bob.waitForMessage();
    expect(got.type).toBe('query');
    expect(got.from).toBe(ALICE);
    expect(got.content).toBe('Which functions does src/auth.ts export?');

    const response = makeMessage({
      callId,
      from: BOB,
      to: ALICE,
      type: 'response',
      content: 'It exports login(), logout(), and refreshSession().',
      inReplyTo: got.id,
      turn: 1,
    });
    await bob.client.send(callId, response);

    const answer = await alice.waitForMessage();
    expect(answer.type).toBe('response');
    expect(answer.from).toBe(BOB);
    expect(answer.inReplyTo).toBe(query.id);
    expect(answer.content).toContain('refreshSession()');

    // Exactly one message each way — relay never duplicated or cross-talked.
    expect(alice.inbox).toHaveLength(1);
    expect(bob.inbox).toHaveLength(1);
  });

  // Scenario 03 — calls are strictly two-party (single-use rendezvous).
  it('rejects a third party joining a code already consumed (UNKNOWN_RENDEZVOUS)', async () => {
    const alice = await endpoint();
    const bob = await endpoint();
    const carol = await endpoint();

    const { code, callId } = await alice.client.start({
      from: ALICE,
      topic: 't',
      maxTurns: 4,
    });
    const joined = await bob.client.join({ from: BOB, code });
    expect(joined.callId).toBe(callId);

    await expect(carol.client.join({ from: CAROL, code })).rejects.toThrow(
      /UNKNOWN_RENDEZVOUS/,
    );
  });

  // Scenario 04 — hangup (and disconnect) notify the peer.
  it('delivers a hangup to the other endpoint and closes the call', async () => {
    const alice = await endpoint();
    const bob = await endpoint();

    const { code, callId } = await alice.client.start({
      from: ALICE,
      topic: 't',
      maxTurns: 4,
    });
    await bob.client.join({ from: BOB, code });

    const peerNotified = bob.waitForHangup();
    await alice.client.hangup(callId);
    const reason = await peerNotified;
    expect(reason).toBe('peer hung up'); // relay default when no reason sent
    expect(bob.hangups).toHaveLength(1);

    // Alice dropped her channel on hangup() → cannot send into the closed call.
    await expect(
      alice.client.send(
        callId,
        makeMessage({ callId, from: ALICE, to: BOB, content: 'still there?' }),
      ),
    ).rejects.toThrow(/no channel for call/);
  });

  it('a peer disconnect (socket close) surfaces as a hangup to the other side', async () => {
    const alice = await endpoint();
    const bob = await endpoint();

    const { code } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });
    await bob.client.join({ from: BOB, code });

    const peerNotified = alice.waitForHangup();
    bob.client.close(); // hard close of the WebSocket
    const reason = await peerNotified;
    expect(reason).toBe('peer disconnected');
  });

  // Scenario 05 — a well-formed but unregistered code fails with UNKNOWN_RENDEZVOUS.
  it('rejects a well-formed but unregistered code with UNKNOWN_RENDEZVOUS', async () => {
    const bob = await endpoint();
    const orphanCode = generatePairingCode(); // never started against the relay
    await expect(bob.client.join({ from: BOB, code: orphanCode })).rejects.toThrow(
      /UNKNOWN_RENDEZVOUS/,
    );
  });

  // Turn cap — every delivered send counts one turn; on cap the relay closes the
  // call and hangs up BOTH ends with a "turn cap" reason.
  it('enforces the turn cap and hangs up BOTH ends on the capping send', async () => {
    const alice = await endpoint();
    const bob = await endpoint();

    const { code, callId } = await alice.client.start({
      from: ALICE,
      topic: 'capped',
      maxTurns: 2,
    });
    await bob.client.join({ from: BOB, code });

    // Turn 1: Alice asks.
    await alice.client.send(
      callId,
      makeMessage({ callId, from: ALICE, to: BOB, type: 'query', content: 'q1' }),
    );
    await bob.waitForMessage(1);

    // Turn 2: Bob answers — this consumes the last allowed turn.
    await bob.client.send(
      callId,
      makeMessage({ callId, from: BOB, to: ALICE, type: 'response', content: 'a1', turn: 1 }),
    );
    await alice.waitForMessage(1);

    // The capping send: delivery is refused, the call is closed, both ends hung up.
    const aHang = alice.waitForHangup();
    const bHang = bob.waitForHangup();
    await alice.client.send(
      callId,
      makeMessage({ callId, from: ALICE, to: BOB, type: 'query', content: 'q2 (over cap)' }),
    );
    const [ra, rb] = await Promise.all([aHang, bHang]);
    expect(ra).toMatch(/turn cap/);
    expect(rb).toMatch(/turn cap/);

    // The over-cap query was never delivered to Bob (cap precedes routing).
    expect(bob.inbox).toHaveLength(1);
  });

  // Scenario 10 — a message fired the instant the peer joins must not be dropped.
  it('delivers a message sent the instant the peer joins (no join-race drop)', async () => {
    const a = await endpoint();
    const b = await endpoint();

    const got: string[] = [];
    b.client.onMessage((m) => got.push(m.content));

    const started = await a.client.start({ from: '@a/x' as Extension, topic: 't' });
    a.client.onPeerJoined((cid, peer) => {
      void a.client.send(
        cid,
        makeMessage({ callId: cid, from: '@a/x' as Extension, to: peer, content: 'hello on join' }),
      );
    });

    await b.client.join({ from: '@b/y' as Extension, code: started.code });
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toContain('hello on join');
  });
});
