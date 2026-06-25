import { describe, it, expect, afterEach } from 'vitest';
import { startRelay } from '@switchboard/relay';
import type { RelayHandle } from '@switchboard/relay';
import { SwitchboardClient } from '@switchboard/client';
import { newMessageId, PROTOCOL_VERSION } from '@switchboard/protocol';
import type { Extension } from '@switchboard/protocol';

/**
 * Regression for the join-race found in the first real cross-machine test:
 * the opener fired a message the instant the peer joined, and the joiner
 * DROPPED it ("deliver for unknown call") because the client registered the
 * per-call channel in the awaited join() continuation rather than synchronously
 * when the `joined`/`opened` frame arrived. ws can emit `joined` and the
 * following `deliver` in one synchronous batch, so the channel must be set
 * before any deliver is processed.
 */
describe('immediate send on join', () => {
  let relay: RelayHandle | undefined;
  afterEach(async () => {
    if (relay) {
      await relay.close();
      relay = undefined;
    }
  });

  it('delivers a message sent the instant the peer joins (no drop)', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${relay.port}`;
    const A = await SwitchboardClient.connect(url);
    const B = await SwitchboardClient.connect(url);

    const got: string[] = [];
    B.onMessage((m) => got.push(m.content));

    const started = await A.start({ from: '@a/x' as Extension, topic: 't' });

    // Opener sends the moment the peer joins — the exact race.
    A.onPeerJoined((callId, peer) => {
      void A.send(callId, {
        v: PROTOCOL_VERSION,
        id: newMessageId(),
        callId,
        from: '@a/x' as Extension,
        to: peer,
        type: 'query',
        ts: new Date().toISOString(),
        turn: 0,
        inReplyTo: null,
        content: 'hello on join',
      });
    });

    await B.join({ from: '@b/y' as Extension, code: started.code });
    await new Promise((r) => setTimeout(r, 300));

    expect(got).toContain('hello on join');

    A.close();
    B.close();
  });
});
