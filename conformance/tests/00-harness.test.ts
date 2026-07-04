import { describe, it, expect, afterEach } from 'vitest';
import { parseMessage } from '@magpie/protocol';
import { makeHarness, makeMessage, ALICE, BOB } from '../src/harness.js';
import type { Harness } from '../src/harness.js';

/**
 * Harness sanity: the rig itself must be trustworthy before the behavioral
 * corpus leans on it. Pins that the relay boots, endpoints connect, makeMessage
 * produces a schema-valid Message, and dispose() is idempotent.
 */
describe('conformance/00 harness sanity', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it('boots a relay on an ephemeral port and connects endpoints', async () => {
    h = await makeHarness();
    expect(h.relay.port).toBeGreaterThan(0);
    expect(h.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    const a = await h.endpoint();
    const b = await h.endpoint();
    expect(a.client).toBeDefined();
    expect(b.client).toBeDefined();
    expect(a.inbox).toHaveLength(0);
    expect(a.hangups).toHaveLength(0);
  });

  it('makeMessage yields a Message that passes parseMessage', () => {
    const msg = makeMessage({
      callId: 'call-0123456789abcdef',
      from: ALICE,
      to: BOB,
      content: 'sanity',
    });
    expect(() => parseMessage(msg)).not.toThrow();
    expect(msg.id).toMatch(/^msg-/);
    expect(msg.type).toBe('query');
  });

  it('dispose() can be called twice without throwing', async () => {
    h = await makeHarness();
    await h.dispose();
    await expect(h.dispose()).resolves.toBeUndefined();
    h = undefined;
  });
});
