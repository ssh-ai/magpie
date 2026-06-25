import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, ALICE, BOB, CAROL } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * SCENARIO 6 (prior art: re-joining / expired session token is rejected).
 *
 * A pairing code is SINGLE-USE and TIME-LIMITED:
 *   - re-join: once consumed, the same code can't be redeemed again;
 *   - expiry: after the pairing TTL, the code is dead even if never consumed.
 * Both must be rejected with a typed relay error, never silently accepted.
 */
describe('conformance/06 re-join / expired-code rejection', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('rejects re-joining a code that was already consumed by a peer', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();
    const carol = await h.endpoint();

    const { code } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });

    await bob.client.join({ from: BOB, code }); // first redemption succeeds
    // Re-join with the same code: rendezvous already consumed.
    await expect(carol.client.join({ from: CAROL, code })).rejects.toThrow(/UNKNOWN_RENDEZVOUS/);
    // Even the original joiner can't redeem it twice.
    await expect(bob.client.join({ from: BOB, code })).rejects.toThrow(/UNKNOWN_RENDEZVOUS/);
  });

  it('rejects joining after the pairing code has expired (TTL elapsed)', async () => {
    // Negative TTL: now() - createdAt (>= 0) is ALWAYS > -1, so the pending is
    // considered expired the instant a join arrives — deterministic regardless
    // of the sub-millisecond in-process round trip (a TTL of 0 would race when
    // open+join land in the same millisecond).
    h = await makeHarness({ pairingTtlMs: -1 });
    const alice = await h.endpoint();
    const bob = await h.endpoint();

    const { code } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });

    // The relay computes now() - createdAt > 0 on join and reaps the pending.
    // Depending on scheduling that surfaces as EXPIRED (caught in time) or
    // UNKNOWN_RENDEZVOUS (already swept) — both are clean, typed rejections.
    await expect(bob.client.join({ from: BOB, code })).rejects.toThrow(
      /EXPIRED|UNKNOWN_RENDEZVOUS/,
    );

    // And the call never came up: Alice saw nothing.
    expect(alice.inbox).toHaveLength(0);
    expect(alice.hangups).toHaveLength(0);
  });
});
