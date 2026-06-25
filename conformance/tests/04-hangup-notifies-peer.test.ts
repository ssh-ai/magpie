import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, makeMessage, ALICE, BOB } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * SCENARIO 4 (prior art: ending a session notifies the other side).
 *
 * When one endpoint hangs up, the peer is told the call ended (and why). After
 * hangup, the call is closed: a further send from either side is refused —
 * here the client refuses locally because hangup() drops its channel.
 */
describe('conformance/04 hangup notification reaches the peer', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('delivers a hangup to the OTHER endpoint and closes the call', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();

    const { code, callId } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });
    await bob.client.join({ from: BOB, code });

    // Alice hangs up; Bob must be notified.
    const peerNotified = bob.waitForHangup();
    await alice.client.hangup(callId);
    const reason = await peerNotified;
    expect(reason).toBe('peer hung up'); // relay default when client sends no reason
    expect(bob.hangups).toHaveLength(1);

    // The call is closed both sides: Alice dropped her channel on hangup().
    await expect(
      alice.client.send(
        callId,
        makeMessage({ callId, from: ALICE, to: BOB, content: 'still there?' }),
      ),
    ).rejects.toThrow(/no channel for call/);
  });

  it('a peer disconnect (socket close) also surfaces as a hangup to the other side', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();

    const { code } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });
    await bob.client.join({ from: BOB, code });

    const peerNotified = alice.waitForHangup();
    bob.client.close(); // hard close of the WebSocket
    const reason = await peerNotified;
    expect(reason).toBe('peer disconnected');
  });
});
