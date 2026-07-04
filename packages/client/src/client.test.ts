import { describe, it, expect } from 'vitest';
import {
  generatePairingCode,
  channelFromCode,
  newMessageId,
  newCallId,
  parseMessage,
  PROTOCOL_VERSION,
} from '@magpie/protocol';
import type { Message } from '@magpie/protocol';

/**
 * The load-bearing invariant of the whole system: a Message sealed by one
 * endpoint's channel (derived from the shared code) is byte-for-byte
 * recoverable by the other endpoint's channel derived from the SAME code, and
 * survives a parseMessage() round-trip. This is exactly the seal/open path
 * MagpieClient.send/#onDeliver use, minus the WebSocket.
 */

function makeMessage(overrides: Partial<Message> = {}): Message {
  const base: Message = {
    v: PROTOCOL_VERSION,
    id: newMessageId(),
    callId: newCallId(),
    from: '@chris/impl',
    to: '@sora/strategy',
    type: 'query',
    ts: new Date().toISOString(),
    turn: 0,
    inReplyTo: null,
    content: 'hello from the other side',
  };
  return { ...base, ...overrides };
}

describe('code -> channel round-trip seal/open', () => {
  it('recovers the exact Message across two channels from the same code', () => {
    const code = generatePairingCode();
    const sealer = channelFromCode(code); // opener
    const opener = channelFromCode(code); // joiner (same code, independent instance)

    const msg = makeMessage();

    // send() path: JSON -> utf8 -> seal -> base64
    const plaintext = Buffer.from(JSON.stringify(msg), 'utf8');
    const sealed = sealer.seal(plaintext);
    const onWire = Buffer.from(sealed).toString('base64');

    // #onDeliver path: base64 -> open -> utf8 -> JSON -> parseMessage
    const ciphertext = Buffer.from(onWire, 'base64');
    const recoveredBytes = opener.open(ciphertext);
    const recovered = parseMessage(JSON.parse(Buffer.from(recoveredBytes).toString('utf8')));

    expect(recovered).toEqual(msg);
  });

  it('produces fresh ciphertext each seal (random IV) yet opens identically', () => {
    const code = generatePairingCode();
    const ch = channelFromCode(code);
    const pt = Buffer.from('same plaintext', 'utf8');

    const a = Buffer.from(ch.seal(pt)).toString('base64');
    const b = Buffer.from(ch.seal(pt)).toString('base64');

    expect(a).not.toEqual(b); // nonce makes ciphertext non-deterministic
    expect(Buffer.from(ch.open(Buffer.from(a, 'base64'))).toString('utf8')).toBe('same plaintext');
    expect(Buffer.from(ch.open(Buffer.from(b, 'base64'))).toString('utf8')).toBe('same plaintext');
  });

  it('rejects ciphertext sealed under a different code (wrong key)', () => {
    const sealer = channelFromCode(generatePairingCode());
    const wrong = channelFromCode(generatePairingCode());
    const sealed = sealer.seal(Buffer.from('secret', 'utf8'));
    expect(() => wrong.open(sealed)).toThrow();
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const code = generatePairingCode();
    const ch = channelFromCode(code);
    const sealed = Buffer.from(ch.seal(Buffer.from('integrity', 'utf8')));
    const last = sealed.length - 1;
    sealed.writeUInt8(sealed.readUInt8(last) ^ 0xff, last); // flip a byte in the tail
    expect(() => ch.open(sealed)).toThrow();
  });
});
