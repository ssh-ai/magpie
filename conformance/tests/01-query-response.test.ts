import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, makeMessage, ALICE, BOB } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * SCENARIO 1 (prior art: claude-code-session-bridge "ask + answer").
 *
 * Alice opens a call, Bob joins with the shared code, Alice sends a `query`,
 * Bob receives it decrypted+validated and replies with a `response` that
 * arrives back at Alice. The relay only ever brokered ciphertext.
 */
describe('conformance/01 query <-> response round trip', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('delivers a query to the peer and the response back to the asker', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();

    const { code, callId } = await alice.client.start({
      from: ALICE,
      topic: 'what does the auth module export?',
      maxTurns: 6,
    });
    const joined = await bob.client.join({ from: BOB, code });

    // Both sides agree on the same call.
    expect(joined.callId).toBe(callId);
    expect(joined.callId).toMatch(/^call-/);

    // Alice asks.
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
    expect(got.to).toBe(BOB);
    expect(got.content).toBe('Which functions does src/auth.ts export?');

    // Bob answers, threading inReplyTo back to the query id.
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

    // Exactly one message each way — no spurious deliveries.
    expect(alice.inbox).toHaveLength(1);
    expect(bob.inbox).toHaveLength(1);
  });
});
