/**
 * @switchboard/protocol — the canonical contract every Switchboard package
 * builds against. Message schema, pairing/handshake, and security primitives.
 */
export * from './constants.js';
export * from './schema.js';
export * from './pairing.js';
export * from './security.js';

import { customAlphabet } from 'nanoid';
const idChars = '0123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz_-';
const nano = customAlphabet(idChars, 16);

export function newMessageId(): string {
  return `msg-${nano()}`;
}
export function newCallId(): string {
  return `call-${nano()}`;
}
