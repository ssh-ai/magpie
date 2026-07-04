/**
 * @magpie/relay — the central magpie.
 *
 * A WebSocket server that pairs two endpoints at a rendezvous and routes opaque
 * sealed frames between them. It brokers CIPHERTEXT ONLY: it never unseals a
 * payload and never touches the filesystem.
 */
export { startRelay, RelayServer } from './server.js';
export type { RelayOptions, RelayHandle } from './server.js';
export { CallRegistry, clampMaxTurns, RegistryError } from './store.js';
export type { Pending, LiveCall, RegistryOptions } from './store.js';
export {
  ClientFrame,
  OpenFrame,
  JoinFrame,
  SendFrame,
  HangupFrame,
  RendezvousId,
  SealedFrame,
} from './wire.js';
export type { ServerFrame, ErrorCode } from './wire.js';
