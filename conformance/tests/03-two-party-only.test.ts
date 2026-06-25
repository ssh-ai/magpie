import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, ALICE, BOB, CAROL } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * SCENARIO 3 (prior art: a "session" is strictly two parties).
 *
 * A call is single-use at the rendezvous: once a second participant joins, the
 * rendezvous is consumed, so a THIRD client presenting the same code can never
 * wedge into the call. There is no fan-out, no group — exactly two endpoints.
 *
 * The relay enforces this at the registry (single-use pending). The client
 * surfaces the relay's refusal as a rejected join() promise.
 */
describe('conformance/03 multi-peer routing is rejected (calls are 2-party)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('rejects a third party joining a code that has already been consumed', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();
    const carol = await h.endpoint();

    const { code, callId } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });

    // Bob legitimately consumes the rendezvous.
    const joined = await bob.client.join({ from: BOB, code });
    expect(joined.callId).toBe(callId);

    // Carol tries the SAME code — the rendezvous is gone (single-use).
    await expect(carol.client.join({ from: CAROL, code })).rejects.toThrow(/UNKNOWN_RENDEZVOUS/);
  });

  it('rejects a non-participant trying to send into an established two-party call', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();
    const carol = await h.endpoint();

    const { code, callId } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });
    await bob.client.join({ from: BOB, code });

    // Carol never joined this call, so she holds no channel for it; the client
    // refuses to seal/send for a call it isn't part of. (Defense in depth: even
    // a hand-crafted frame would be rejected NOT_PARTICIPANT by the relay, since
    // routing is keyed on socket identity, not the claimed `from`.)
    expect(carol.client['send']).toBeTypeOf('function');
    await expect(
      // @ts-expect-error intentionally sending with no channel for callId
      carol.client.send(callId, { content: 'let me in' }),
    ).rejects.toThrow(/no channel for call/);
  });
});
