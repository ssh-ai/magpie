import { describe, it, expect } from 'vitest';
import { ABSOLUTE_MAX_TURNS, DEFAULT_MAX_TURNS } from '@switchboard/protocol';
import { CallRegistry, clampMaxTurns, RegistryError } from './store.js';

const RID = 'a'.repeat(32);

describe('clampMaxTurns', () => {
  it('defaults, clamps to the absolute ceiling, and floors at 1', () => {
    expect(clampMaxTurns(undefined)).toBe(DEFAULT_MAX_TURNS);
    expect(clampMaxTurns(999)).toBe(ABSOLUTE_MAX_TURNS);
    expect(clampMaxTurns(0)).toBe(1);
    expect(clampMaxTurns(-5)).toBe(1);
    expect(clampMaxTurns(3.9)).toBe(3);
  });
});

describe('CallRegistry pairing TTL', () => {
  it('expires a pending rendezvous after the TTL', () => {
    let t = 1000;
    const reg = new CallRegistry<symbol>({ pairingTtlMs: 100, now: () => t });
    reg.open({ rendezvousId: RID, from: '@a/x', topic: 't', maxTurns: 4, opener: Symbol('a') });
    t = 1201; // past TTL
    expect(() => reg.join({ rendezvousId: RID, from: '@b/y', joiner: Symbol('b') })).toThrow(
      RegistryError,
    );
    expect(reg.pendingCount).toBe(0);
  });

  it('refuses a second opener at the same rendezvous (ALREADY_PAIRED)', () => {
    const reg = new CallRegistry<symbol>();
    reg.open({ rendezvousId: RID, from: '@a/x', topic: 't', maxTurns: 4, opener: Symbol('a') });
    expect(() =>
      reg.open({ rendezvousId: RID, from: '@c/z', topic: 't', maxTurns: 4, opener: Symbol('c') }),
    ).toThrowError(/already/);
  });

  it('consumes the rendezvous on join (single use)', () => {
    const reg = new CallRegistry<symbol>();
    reg.open({ rendezvousId: RID, from: '@a/x', topic: 't', maxTurns: 4, opener: Symbol('a') });
    reg.join({ rendezvousId: RID, from: '@b/y', joiner: Symbol('b') });
    expect(() => reg.join({ rendezvousId: RID, from: '@d/w', joiner: Symbol('d') })).toThrow(
      RegistryError,
    );
  });
});

describe('CallRegistry turn cap', () => {
  it('throws TURN_CAP at maxTurns and closes the call', () => {
    const reg = new CallRegistry<symbol>();
    reg.open({ rendezvousId: RID, from: '@a/x', topic: 't', maxTurns: 2, opener: Symbol('a') });
    const call = reg.join({ rendezvousId: RID, from: '@b/y', joiner: Symbol('b') });
    reg.consumeQueryTurn(call);
    reg.consumeQueryTurn(call);
    expect(() => reg.consumeQueryTurn(call)).toThrowError(/turn cap/);
    expect(call.state).toBe('closed');
    expect(call.turn).toBe(2);
  });
});

describe('CallRegistry idle reaping', () => {
  it('reaps a call idle past CALL_IDLE_TTL_MS', () => {
    let t = 0;
    const reg = new CallRegistry<symbol>({ callIdleTtlMs: 50, now: () => t });
    reg.open({ rendezvousId: RID, from: '@a/x', topic: 't', maxTurns: 4, opener: Symbol('a') });
    const call = reg.join({ rendezvousId: RID, from: '@b/y', joiner: Symbol('b') });
    t = 100; // idle past TTL
    const { reaped } = reg.reap();
    expect(reaped).toContain(call);
    expect(reg.callCount).toBe(0);
  });
});
