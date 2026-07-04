/**
 * @magpie/client — wraps a WebSocket to the relay plus the per-call
 * pairing crypto. The relay only ever sees ciphertext.
 */
export { MagpieClient } from './client.js';
export type {
  ClientToRelay,
  RelayToClient,
  OpenFrame,
  JoinFrame,
  SendFrame,
  HangupFrame,
  OpenedFrame,
  JoinedFrame,
  PeerJoinedFrame,
  DeliverFrame,
  HangupDeliverFrame,
  ErrorFrame,
} from './wire.js';
export { parseRelayFrame } from './wire.js';
