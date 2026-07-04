import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { rendezvousId, generatePairingCode } from '@magpie/protocol';
import { startRelay } from './server.js';
import type { RelayHandle } from './server.js';
import type { ServerFrame } from './wire.js';

/**
 * Drive the relay through two real in-process WebSocket clients.
 */

let relay: RelayHandle | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.terminate();
    } catch {
      /* ignore */
    }
  }
  if (relay) {
    await relay.close();
    relay = undefined;
  }
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the next server frame, optionally waiting for a given `t`. */
function nextFrame(ws: WebSocket, t?: ServerFrame['t']): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as ServerFrame;
      if (t && frame.t !== t) return; // keep waiting for the requested type
      ws.off('message', onMsg);
      resolve(frame);
    };
    ws.on('message', onMsg);
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

const FROM_A = '@chris/impl';
const FROM_B = '@sora/strategy';

describe('relay open/join/deliver', () => {
  it('pairs two clients and routes a sealed frame to the OTHER endpoint', async () => {
    relay = await startRelay(0);
    const a = await connect(relay.port);
    const b = await connect(relay.port);

    const rid = rendezvousId(generatePairingCode());

    // A opens.
    send(a, { t: 'open', rendezvousId: rid, from: FROM_A, topic: 'design review', maxTurns: 4 });
    const opened = await nextFrame(a, 'opened');
    expect(opened.t).toBe('opened');
    const callId = (opened as { callId: string }).callId;
    expect(callId).toMatch(/^call-/);

    // B joins; B learns the peer, A is told B joined.
    const peerJoinedP = nextFrame(a, 'peer-joined');
    send(b, { t: 'join', rendezvousId: rid, from: FROM_B });
    const joined = await nextFrame(b, 'joined');
    expect(joined).toMatchObject({ t: 'joined', callId, peer: FROM_A });

    const peerJoined = await peerJoinedP;
    expect(peerJoined).toMatchObject({ t: 'peer-joined', callId, peer: FROM_B });

    // A sends a sealed frame; it must arrive at B (the OTHER endpoint), verbatim.
    const sealed = Buffer.from('not-real-ciphertext-but-base64-shaped').toString('base64');
    const deliverP = nextFrame(b, 'deliver');
    send(a, { t: 'send', callId, frame: sealed });
    const delivered = await deliverP;
    expect(delivered).toMatchObject({ t: 'deliver', callId, frame: sealed });
  });

  it('rejects join on an unknown rendezvous', async () => {
    relay = await startRelay(0);
    const b = await connect(relay.port);
    const rid = rendezvousId(generatePairingCode());
    send(b, { t: 'join', rendezvousId: rid, from: FROM_B });
    const err = await nextFrame(b, 'error');
    expect(err).toMatchObject({ t: 'error', code: 'UNKNOWN_RENDEZVOUS' });
  });

  it('rejects malformed control frames', async () => {
    relay = await startRelay(0);
    const a = await connect(relay.port);
    send(a, { t: 'open', rendezvousId: 'not-hex', from: 'bad-extension', topic: 'x' });
    const err = await nextFrame(a, 'error');
    expect(err).toMatchObject({ t: 'error', code: 'BAD_FRAME' });
  });

  it('enforces the turn cap and refuses delivery past maxTurns', async () => {
    relay = await startRelay(0);
    const a = await connect(relay.port);
    const b = await connect(relay.port);
    const rid = rendezvousId(generatePairingCode());

    // maxTurns: 2 — only two sends may be delivered.
    send(a, { t: 'open', rendezvousId: rid, from: FROM_A, topic: 't', maxTurns: 2 });
    const opened = await nextFrame(a, 'opened');
    const callId = (opened as { callId: string }).callId;

    send(b, { t: 'join', rendezvousId: rid, from: FROM_B });
    await nextFrame(b, 'joined');

    const sealed = Buffer.from('frame').toString('base64');

    // Turn 1: delivered.
    let deliverP = nextFrame(b, 'deliver');
    send(a, { t: 'send', callId, frame: sealed });
    expect((await deliverP).t).toBe('deliver');

    // Turn 2: delivered (cap reached after this).
    deliverP = nextFrame(a, 'deliver');
    send(b, { t: 'send', callId, frame: sealed });
    expect((await deliverP).t).toBe('deliver');

    // Turn 3: cap reached — the call is closed and BOTH ends get a clean
    // hangup (so each side stops + escalates), and NEITHER gets a deliver.
    let peerGotThird = false;
    b.on('message', (d: Buffer) => {
      if ((JSON.parse(d.toString('utf8')) as ServerFrame).t === 'deliver') peerGotThird = true;
    });
    const aHangupP = nextFrame(a, 'hangup');
    const bHangupP = nextFrame(b, 'hangup');
    send(a, { t: 'send', callId, frame: sealed });
    const [aHangup, bHangup] = await Promise.all([aHangupP, bHangupP]);
    expect(aHangup).toMatchObject({ t: 'hangup', callId });
    expect((aHangup as { reason: string }).reason).toMatch(/turn cap/i);
    expect(bHangup).toMatchObject({ t: 'hangup', callId });
    expect(peerGotThird).toBe(false);
  });

  it('routes hangup to the other endpoint', async () => {
    relay = await startRelay(0);
    const a = await connect(relay.port);
    const b = await connect(relay.port);
    const rid = rendezvousId(generatePairingCode());

    send(a, { t: 'open', rendezvousId: rid, from: FROM_A, topic: 't', maxTurns: 4 });
    const callId = ((await nextFrame(a, 'opened')) as { callId: string }).callId;
    send(b, { t: 'join', rendezvousId: rid, from: FROM_B });
    await nextFrame(b, 'joined');

    const hangupP = nextFrame(b, 'hangup');
    send(a, { t: 'hangup', callId, reason: 'done' });
    expect(await hangupP).toMatchObject({ t: 'hangup', callId, reason: 'done' });
  });
});
