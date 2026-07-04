import { describe, it, expect, afterEach } from 'vitest';
import { MAX_CONTENT_BYTES, parseMessage } from '@magpie/protocol';
import { makeHarness, makeMessage, ALICE, BOB } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * SECURITY (a): oversized content (> MAX_CONTENT_BYTES) is rejected.
 *
 * Anti-DoS / anti-context-blowup. The cap is enforced in THREE places, all of
 * which this test pins:
 *   1. the zod schema refinement (parseMessage),
 *   2. the client's own outbound guard in MagpieClient.send,
 *   3. content exactly AT the cap is still accepted (boundary is inclusive).
 */
describe('conformance/07 security — oversized content is rejected', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('parseMessage rejects content one byte over MAX_CONTENT_BYTES', () => {
    const tooBig = 'a'.repeat(MAX_CONTENT_BYTES + 1); // ASCII => 1 byte/char
    const msg = makeMessage({
      callId: 'call-0123456789abcdef',
      from: ALICE,
      to: BOB,
      content: tooBig,
    });
    expect(() => parseMessage(msg)).toThrow(/exceeds .* bytes/);
  });

  it('parseMessage accepts content exactly AT the cap (inclusive boundary)', () => {
    const atCap = 'a'.repeat(MAX_CONTENT_BYTES);
    const msg = makeMessage({
      callId: 'call-0123456789abcdef',
      from: ALICE,
      to: BOB,
      content: atCap,
    });
    expect(() => parseMessage(msg)).not.toThrow();
  });

  it('MagpieClient.send refuses to seal+ship oversized content', async () => {
    h = await makeHarness();
    const alice = await h.endpoint();
    const bob = await h.endpoint();

    const { code, callId } = await alice.client.start({ from: ALICE, topic: 't', maxTurns: 4 });
    await bob.client.join({ from: BOB, code });

    const oversized = makeMessage({
      callId,
      from: ALICE,
      to: BOB,
      content: 'x'.repeat(MAX_CONTENT_BYTES + 1024),
    });
    await expect(alice.client.send(callId, oversized)).rejects.toThrow(/exceeds .* bytes/);

    // Nothing reached the peer.
    expect(bob.inbox).toHaveLength(0);
  });

  it('counts BYTES not characters — multibyte content over the cap is rejected', () => {
    // '✓' is 3 UTF-8 bytes; just over a third of the cap in chars blows the byte cap.
    const charCount = Math.floor(MAX_CONTENT_BYTES / 3) + 1;
    const multibyte = '✓'.repeat(charCount);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_CONTENT_BYTES);
    const msg = makeMessage({
      callId: 'call-0123456789abcdef',
      from: ALICE,
      to: BOB,
      content: multibyte,
    });
    expect(() => parseMessage(msg)).toThrow(/exceeds .* bytes/);
  });
});
