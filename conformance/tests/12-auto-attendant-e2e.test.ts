import { describe, it, expect, afterEach } from 'vitest';
import { startRelay } from '@magpie/relay';
import type { RelayHandle } from '@magpie/relay';
import { MagpieClient } from '@magpie/client';
import { AutoAttendant } from '@magpie/auto-attendant';
import type { Responder } from '@magpie/auto-attendant';
import { newMessageId, PROTOCOL_VERSION, DEFAULT_MAX_TURNS } from '@magpie/protocol';
import type { Extension } from '@magpie/protocol';

/**
 * Mode ② wiring, deterministically: an AutoAttendant (with a fake, deterministic
 * Responder standing in for the real claude/codex CLI) staffs a call over the
 * REAL relay + client, and an asker actually receives its answer over the wire.
 * Proves the relay ↔ client ↔ AutoAttendant ↔ Responder path end-to-end without
 * depending on a live model. (The real-claude path is a manual smoke.)
 */
describe('auto-attendant end-to-end (real relay + client, fake brain)', () => {
  let relay: RelayHandle | undefined;
  afterEach(async () => {
    if (relay) {
      await relay.close();
      relay = undefined;
    }
  });

  it('staffs a call and answers the asker over the wire', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${relay.port}`;
    const asker = await MagpieClient.connect(url);
    const staff = await MagpieClient.connect(url);

    const started = await asker.start({ from: '@a/pm' as Extension, topic: 'project structure' });
    const joined = await staff.join({ from: '@b/agent' as Extension, code: started.code });

    const responder: Responder = {
      id: 'fake',
      answer: (input) =>
        Promise.resolve({ text: `re "${input.question}": see packages/protocol`, confident: true }),
    };
    const aa = new AutoAttendant({
      self: '@b/agent' as Extension,
      callId: joined.callId,
      cwd: '/repo',
      topic: 'project structure',
      responder,
      transport: staff,
      maxTurns: DEFAULT_MAX_TURNS,
    });
    aa.start();

    const got: string[] = [];
    asker.onMessage((m) => got.push(m.content));

    await asker.send(started.callId, {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: started.callId,
      from: '@a/pm' as Extension,
      to: '@b/agent' as Extension,
      type: 'query',
      ts: new Date().toISOString(),
      turn: 0,
      inReplyTo: null,
      content: 'where is the message schema?',
    });

    for (let i = 0; i < 60 && got.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(got).toHaveLength(1);
    expect(got[0]).toContain('packages/protocol');

    asker.close();
    staff.close();
  });
});
