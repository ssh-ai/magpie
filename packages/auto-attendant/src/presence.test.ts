import { describe, it, expect } from 'vitest';
import { goOnDuty, dutyPresence } from './presence.js';

describe('duty presence', () => {
  const handle = `@test/presence-${process.pid}`;

  it('is false when never marked on duty', () => {
    expect(dutyPresence(`@nobody/${process.pid}-x`)()).toBe(false);
  });

  it('is true right after going on duty', () => {
    goOnDuty(handle);
    expect(dutyPresence(handle, 30_000)()).toBe(true);
  });

  it('treats a zero/negative freshness window as never-live', () => {
    goOnDuty(handle);
    expect(dutyPresence(handle, 0)()).toBe(false);
  });
});
