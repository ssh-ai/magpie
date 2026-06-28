import { describe, it, expect } from 'vitest';
import { newCallId, newMessageId, PROTOCOL_VERSION } from '@switchboard/protocol';
import type { Extension, Message } from '@switchboard/protocol';
import { AutoDriver } from './driver.js';
import type { DriverBrain, DriverDecision } from './driver.js';
import type { CallTransport } from './auto-attendant.js';
import { parseDriverDecision } from './driver-adapters.js';

const SELF: Extension = '@a/planner';
const PEER: Extension = '@b/impl';
const CALL = newCallId();

class FakeBrain implements DriverBrain {
  readonly id = 'fake';
  calls = 0;
  constructor(private readonly decisions: DriverDecision[]) {}
  step(): Promise<DriverDecision> {
    const d = this.decisions[this.calls] ?? { kind: 'agree', summary: 'done' };
    this.calls += 1;
    return Promise.resolve(d);
  }
}

class FakeTransport implements CallTransport {
  sent: Message[] = [];
  hangups = 0;
  resolves: string[] = [];
  #onMessage: ((m: Message) => void) | null = null;
  onMessage(cb: (m: Message) => void): void {
    this.#onMessage = cb;
  }
  onHangup(): void {
    /* unused here */
  }
  async send(_c: string, m: Message): Promise<void> {
    this.sent.push(m);
  }
  async hangup(): Promise<void> {
    this.hangups += 1;
  }
  async resolve(_c: string, s: string): Promise<void> {
    this.resolves.push(s);
    this.hangups += 1;
  }
  deliver(text: string): void {
    const m: Message = {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: CALL,
      from: PEER,
      to: SELF,
      type: 'response',
      ts: new Date().toISOString(),
      turn: 0,
      inReplyTo: null,
      content: text,
    };
    this.#onMessage?.(m);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function makeDriver(brain: DriverBrain, transport: FakeTransport, maxTurns = 10) {
  return new AutoDriver({
    self: SELF,
    peer: PEER,
    callId: CALL,
    cwd: '/spec',
    goal: 'verify rule X matches the spec',
    brain,
    transport,
    maxTurns,
  });
}

describe('AutoDriver', () => {
  it('opens, pushes back, then resolves on agreement', async () => {
    const brain = new FakeBrain([
      { kind: 'say', text: 'is rule X implemented?' },
      { kind: 'say', text: 'no — spec says 2%, your code says 3%' },
      { kind: 'agree', summary: 'fixed to 2% per spec' },
    ]);
    const t = new FakeTransport();
    const d = makeDriver(brain, t);
    const agreed: { summary: string }[] = [];
    d.on('agreed', (e) => agreed.push(e));

    await d.start();
    expect(t.sent[0]!.content).toBe('is rule X implemented?');
    expect(t.sent[0]!.type).toBe('query');

    t.deliver('it is implemented at risk.ts');
    await tick();
    expect(t.sent[1]!.content).toContain('spec says 2%');

    t.deliver('good catch, changed to 2%');
    await tick();

    expect(t.resolves).toEqual(['fixed to 2% per spec']);
    expect(agreed).toEqual([{ callId: CALL, summary: 'fixed to 2% per spec' }]);
  });

  it('escalates at the turn cap without agreement', async () => {
    const brain = new FakeBrain([
      { kind: 'say', text: 'a' },
      { kind: 'say', text: 'b' },
      { kind: 'say', text: 'c' },
    ]);
    const t = new FakeTransport();
    const d = makeDriver(brain, t, 2);
    const escalations: { reason: string }[] = [];
    d.on('escalate', (e) => escalations.push(e));

    await d.start(); // turn 1: 'a'
    t.deliver('r1');
    await tick(); // turn 2: 'b'
    t.deliver('r2');
    await tick(); // turn cap -> escalate

    expect(t.sent).toHaveLength(2);
    expect(t.hangups).toBe(1);
    expect(t.resolves).toHaveLength(0);
    expect(escalations[0]!.reason).toBe('turn-cap');
  });

  it('escalates (not crashes) when the brain throws', async () => {
    const brain: DriverBrain = {
      id: 'boom',
      step: () => Promise.reject(new Error('cli not found')),
    };
    const t = new FakeTransport();
    const d = makeDriver(brain, t);
    const escalations: { reason: string; detail: string }[] = [];
    d.on('escalate', (e) => escalations.push(e));

    await d.start();

    expect(t.sent).toHaveLength(0);
    expect(escalations[0]!.reason).toBe('brain-error');
    expect(escalations[0]!.detail).toContain('cli not found');
  });
});

describe('parseDriverDecision', () => {
  it('parses AGREE with a summary', () => {
    const d = parseDriverDecision('DECISION: AGREE\nimplementation matches the spec');
    expect(d).toEqual({ kind: 'agree', summary: 'implementation matches the spec' });
  });
  it('parses SAY with a message', () => {
    const d = parseDriverDecision('DECISION: SAY\nplease point me to the order-execution code');
    expect(d).toEqual({ kind: 'say', text: 'please point me to the order-execution code' });
  });
  it('fails closed to SAY when no marker (never a false agree)', () => {
    const d = parseDriverDecision('hmm I think it might be fine');
    expect(d.kind).toBe('say');
  });
});
