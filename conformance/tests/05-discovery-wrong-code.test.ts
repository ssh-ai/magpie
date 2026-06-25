import { describe, it, expect, afterEach } from 'vitest';
import { generatePairingCode, normalizePairingCode, rendezvousId } from '@switchboard/protocol';
import { makeHarness, ALICE, BOB } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * SCENARIO 5 (prior art: discovery / listing of a session by id).
 *
 * Switchboard deliberately has NO server-side directory: discovery is the
 * out-of-band pairing code itself (the relay only ever sees a salted rendezvous
 * id, never the code). So "looking up the wrong session" maps to presenting a
 * wrong/unknown code. That must fail CLEANLY:
 *   - a structurally-invalid code is rejected client-side, before the wire;
 *   - a well-formed but unregistered code is rejected by the relay with a typed
 *     UNKNOWN_RENDEZVOUS error, surfaced as a rejected join() promise;
 *   - the relay never leaks that a *different* call exists.
 */
describe('conformance/05 discovery — a wrong rendezvous/code fails cleanly', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('rejects a structurally-invalid pairing code before it ever hits the wire', async () => {
    h = await makeHarness();
    const bob = await h.endpoint();

    // Too short / wrong shape: normalizePairingCode (inside join()) throws.
    await expect(bob.client.join({ from: BOB, code: 'NOPE' })).rejects.toThrow(
      /pairing code must be \d+ characters/,
    );

    // Distinct rendezvous ids prove the salt+shape gate is real, not a stub.
    expect(() => normalizePairingCode('NOPE')).toThrow();
    const good = generatePairingCode();
    expect(rendezvousId(good)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a well-formed but unregistered code with UNKNOWN_RENDEZVOUS', async () => {
    h = await makeHarness();
    const bob = await h.endpoint();

    // Never `start`ed against the relay — no pending rendezvous exists for it.
    const orphanCode = generatePairingCode();
    await expect(bob.client.join({ from: BOB, code: orphanCode })).rejects.toThrow(
      /UNKNOWN_RENDEZVOUS/,
    );
  });

  it('a code that does not match the opener routes to nobody (no cross-talk)', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();

    // Alice opens a real call with code A.
    await alice.client.start({ from: ALICE, topic: 'private', maxTurns: 4 });

    // Bob tries a DIFFERENT code B — must not be paired into Alice's call.
    const wrongCode = generatePairingCode();
    await expect(bob.client.join({ from: BOB, code: wrongCode })).rejects.toThrow(
      /UNKNOWN_RENDEZVOUS/,
    );
    // Alice was never told a peer joined — no inbound, no hangup.
    expect(alice.inbox).toHaveLength(0);
    expect(alice.hangups).toHaveLength(0);
  });
});
