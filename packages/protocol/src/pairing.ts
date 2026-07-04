import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { CODE_ALPHABET, CODE_GROUPS, CODE_GROUP_LEN } from './constants.js';

/**
 * Pairing & the end-to-end channel.
 *
 * UX: `start` mints a short, human-transcribable code. `join` consumes it.
 * The code is the ONLY secret the two humans share (over their own side
 * channel — KakaoTalk, Slack, voice). The relay never sees the code itself,
 * only a salted rendezvous id derived from it.
 *
 * Security (MVP): the code (~59 bits) is stretched via HKDF into an AES-256-GCM
 * channel key. The relay brokers bytes but cannot read them. This is honest,
 * real crypto. It is secure as long as the code keeps its entropy and is
 * transmitted over a trusted side channel.
 *
 * UPGRADE PATH (v1.1): replace the HKDF-from-code derivation with a PAKE
 * (SPAKE2). PAKE lets the code be MUCH shorter (e.g. 4 chars) while staying
 * MITM-resistant, because the key is never derivable from the code alone.
 * The `PairingChannel` interface below is the seam for that swap.
 */

const CODE_TOTAL_LEN = CODE_GROUPS * CODE_GROUP_LEN;

/** Generate a fresh pairing code, e.g. `K7F3-9M2P-XQ4R`. */
export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_TOTAL_LEN);
  let out = '';
  for (let i = 0; i < CODE_TOTAL_LEN; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out.match(new RegExp(`.{1,${CODE_GROUP_LEN}}`, 'g'))!.join('-');
}

/** Normalize user input (uppercase, strip spaces/dashes) and validate shape. */
export function normalizePairingCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== CODE_TOTAL_LEN) {
    throw new Error(`pairing code must be ${CODE_TOTAL_LEN} characters`);
  }
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) throw new Error(`illegal character in pairing code: ${ch}`);
  }
  return cleaned;
}

/**
 * Rendezvous id the relay uses to pair two endpoints WITHOUT learning the code.
 * HKDF with a fixed public "info" label; distinct from the channel key (different label).
 */
export function rendezvousId(code: string): string {
  const norm = normalizePairingCode(code);
  const out = hkdfSync('sha256', Buffer.from(norm, 'utf8'), Buffer.alloc(0), 'magpie:rendezvous:v1', 16);
  return Buffer.from(out).toString('hex');
}

/** The swappable channel seam. MVP impl below; PAKE impl drops in here later. */
export interface PairingChannel {
  seal(plaintext: Uint8Array): Uint8Array;
  open(ciphertext: Uint8Array): Uint8Array;
}

class HkdfGcmChannel implements PairingChannel {
  readonly #key: Buffer;
  constructor(code: string) {
    const norm = normalizePairingCode(code);
    this.#key = Buffer.from(
      hkdfSync('sha256', Buffer.from(norm, 'utf8'), Buffer.alloc(0), 'magpie:channel:v1', 32),
    );
  }
  seal(plaintext: Uint8Array): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]); // 12 + 16 + n
  }
  open(frame: Uint8Array): Uint8Array {
    const buf = Buffer.from(frame);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on tamper
  }
}

/** Derive the E2E channel from a pairing code (MVP: HKDF→AES-GCM). */
export function channelFromCode(code: string): PairingChannel {
  return new HkdfGcmChannel(code);
}
