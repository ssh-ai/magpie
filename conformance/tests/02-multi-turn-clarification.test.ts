import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, makeMessage, ALICE, BOB } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * SCENARIO 2 (prior art: multi-turn clarification).
 *
 * The peer does not answer immediately — it asks a clarifying follow-up first,
 * the asker answers it, and only then does the peer deliver the real response.
 * Four messages, alternating direction, all threaded by inReplyTo. Verifies the
 * relay sustains a back-and-forth and that turn accounting tolerates it
 * (maxTurns headroom > number of sends).
 */
describe('conformance/02 multi-turn clarification (peer asks a follow-up)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('survives query -> clarify -> clarify-answer -> response', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();

    const { code, callId } = await alice.client.start({
      from: ALICE,
      topic: 'rollout plan',
      maxTurns: 8,
    });
    await bob.client.join({ from: BOB, code });

    // 1) Alice asks an ambiguous question.
    const q = makeMessage({
      callId,
      from: ALICE,
      to: BOB,
      type: 'query',
      content: 'Can we ship the migration this week?',
    });
    await alice.client.send(callId, q);
    const gotQ = await bob.waitForMessage(1);
    expect(gotQ.type).toBe('query');

    // 2) Bob (peer) needs clarification BEFORE answering.
    const clarify = makeMessage({
      callId,
      from: BOB,
      to: ALICE,
      type: 'query',
      content: 'Which migration — the schema one or the auth one?',
      inReplyTo: gotQ.id,
      turn: 1,
    });
    await bob.client.send(callId, clarify);
    const gotClarify = await alice.waitForMessage(1);
    expect(gotClarify.type).toBe('query');
    expect(gotClarify.inReplyTo).toBe(q.id);
    expect(gotClarify.content).toContain('schema one or the auth one');

    // 3) Alice answers the clarification.
    const clarifyAnswer = makeMessage({
      callId,
      from: ALICE,
      to: BOB,
      type: 'response',
      content: 'The schema one.',
      inReplyTo: gotClarify.id,
      turn: 2,
    });
    await alice.client.send(callId, clarifyAnswer);
    const gotClarifyAnswer = await bob.waitForMessage(2);
    expect(gotClarifyAnswer.type).toBe('response');
    expect(gotClarifyAnswer.content).toBe('The schema one.');

    // 4) Now Bob delivers the real answer.
    const finalAnswer = makeMessage({
      callId,
      from: BOB,
      to: ALICE,
      type: 'response',
      content: 'Yes — the schema migration is gated and safe to ship Thursday.',
      inReplyTo: gotClarifyAnswer.id,
      turn: 3,
    });
    await bob.client.send(callId, finalAnswer);
    const gotFinal = await alice.waitForMessage(2);
    expect(gotFinal.type).toBe('response');
    expect(gotFinal.content).toContain('safe to ship Thursday');

    // Each side saw exactly two inbound messages, correctly ordered.
    expect(alice.inbox.map((m) => m.type)).toEqual(['query', 'response']);
    expect(bob.inbox.map((m) => m.type)).toEqual(['query', 'response']);
  });
});
