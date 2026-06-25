import { describe, it, expect, afterEach } from 'vitest';
import { startRelay } from '@switchboard/relay';
import type { RelayHandle } from '@switchboard/relay';
import { SwitchboardClient } from '@switchboard/client';
import { newMessageId, PROTOCOL_VERSION } from '@switchboard/protocol';
import type { Extension } from '@switchboard/protocol';

/**
 * The "report on termination" path: an agent resolves the call with a summary,
 * the peer is notified, and BOTH sides can build a report carrying the outcome,
 * the summary, and the full transcript — the artifact a human reads afterwards.
 */
describe('resolve + report', () => {
  let relay: RelayHandle | undefined;
  afterEach(async () => {
    if (relay) {
      await relay.close();
      relay = undefined;
    }
  });

  it('A resolves with a summary; B is notified; both reports are resolved + carry the transcript', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${relay.port}`;
    const A = await SwitchboardClient.connect(url);
    const B = await SwitchboardClient.connect(url);

    const bResolved: string[] = [];
    B.onResolved((_callId, summary) => bResolved.push(summary));
    const bGot: string[] = [];
    B.onMessage((m) => bGot.push(m.content));

    const started = await A.start({ from: '@a/impl' as Extension, topic: 'risk limit' });
    const joined = await B.join({ from: '@b/strategy' as Extension, code: started.code });

    await A.send(started.callId, {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: started.callId,
      from: '@a/impl' as Extension,
      to: '@b/strategy' as Extension,
      type: 'query',
      ts: new Date().toISOString(),
      turn: 0,
      inReplyTo: null,
      content: 'is per-trade risk 2%?',
    });
    await new Promise((r) => setTimeout(r, 150));

    await A.resolve(started.callId, 'Confirmed: 2% per trade, 6% portfolio max.');
    await new Promise((r) => setTimeout(r, 200));

    // B learned the conclusion, and a resolve is NOT surfaced as a normal message.
    expect(bResolved[0]).toBe('Confirmed: 2% per trade, 6% portfolio max.');
    expect(bGot).toEqual(['is per-trade risk 2%?']);

    const aReport = A.buildReport(started.callId, 'resolved');
    const bReport = B.buildReport(joined.callId, 'resolved');

    expect(aReport?.outcome).toBe('resolved');
    expect(aReport?.summary).toContain('2% per trade');
    // A's transcript: its query + its resolve.
    expect(aReport?.transcript.length).toBeGreaterThanOrEqual(2);

    expect(bReport?.summary).toContain('2% per trade');
    expect(bReport?.transcript.some((e) => e.content === 'is per-trade risk 2%?')).toBe(true);
    expect(bReport?.transcript.some((e) => e.type === 'resolve')).toBe(true);

    A.close();
    B.close();
  });
});
