import { describe, it, expect, vi } from 'vitest';
import { parseRelayPointer, resolveDefaultRelay } from './relay-pointer.js';

describe('parseRelayPointer', () => {
  it('takes the first ws(s):// line, ignoring comments and blanks', () => {
    expect(parseRelayPointer('# hosted relay\n\nwss://relay.fly.dev\n')).toBe('wss://relay.fly.dev');
    expect(parseRelayPointer('   ws://192.168.0.5:8787  ')).toBe('ws://192.168.0.5:8787');
  });

  it('returns null for an unconfigured (comments-only) pointer', () => {
    expect(parseRelayPointer('# not set up yet\n# add a wss:// line below\n')).toBeNull();
    expect(parseRelayPointer('')).toBeNull();
  });

  it('returns null when the first content line is not a valid ws(s) URL', () => {
    expect(parseRelayPointer('https://relay.example')).toBeNull(); // wrong scheme
    expect(parseRelayPointer('not a url')).toBeNull();
  });
});

describe('resolveDefaultRelay', () => {
  const ok = (body: string): typeof fetch =>
    (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it('prefers MAGPIE_RELAY_URL and never fetches', async () => {
    const fetchImpl = vi.fn();
    const url = await resolveDefaultRelay(
      { MAGPIE_RELAY_URL: 'ws://pinned:8787' } as NodeJS.ProcessEnv,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(url).toBe('ws://pinned:8787');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches the pointer when no env override is set', async () => {
    const url = await resolveDefaultRelay({} as NodeJS.ProcessEnv, {
      fetchImpl: ok('wss://relay.fly.dev\n'),
    });
    expect(url).toBe('wss://relay.fly.dev');
  });

  it('disables the hosted default when MAGPIE_RELAY_POINTER is empty', async () => {
    const fetchImpl = vi.fn();
    const url = await resolveDefaultRelay(
      { MAGPIE_RELAY_POINTER: '' } as NodeJS.ProcessEnv,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(url).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('degrades to null (invite-only) on fetch failure — never throws', async () => {
    const boom: typeof fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(
      resolveDefaultRelay({} as NodeJS.ProcessEnv, { fetchImpl: boom }),
    ).resolves.toBeNull();
  });

  it('degrades to null on a non-200 response', async () => {
    const notFound: typeof fetch = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(
      resolveDefaultRelay({} as NodeJS.ProcessEnv, { fetchImpl: notFound }),
    ).resolves.toBeNull();
  });
});
