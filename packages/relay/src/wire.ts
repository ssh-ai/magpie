import { z } from 'zod';
import { Extension, CallId } from '@magpie/protocol';

/**
 * RELAY <-> CLIENT control frames.
 *
 * These are the *transport-control* envelopes spoken over the WebSocket — they
 * are NOT the end-to-end {@link import('@magpie/protocol').Message}. The
 * relay validates and routes these envelopes but treats every `frame` field as
 * opaque sealed ciphertext (base64). It NEVER unseals, parses, or interprets a
 * payload, and it never touches the filesystem.
 */

/** rendezvousId is a hex digest (see protocol `rendezvousId`): 32 hex chars for a 16-byte HKDF output. */
export const RendezvousId = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'rendezvousId must be a 32-char lowercase hex digest');

/** A sealed wire frame: base64 of channel.seal(utf8(JSON(Message))). Opaque to the relay. */
export const SealedFrame = z
  .string()
  .min(1)
  .max(1_500_000, 'sealed frame too large')
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'frame must be base64');

// ---- Client -> Relay ----------------------------------------------------

export const OpenFrame = z
  .object({
    t: z.literal('open'),
    rendezvousId: RendezvousId,
    from: Extension,
    topic: z.string().max(2000),
    maxTurns: z.number().int().positive().optional(),
  })
  .strict();
export type OpenFrame = z.infer<typeof OpenFrame>;

export const JoinFrame = z
  .object({
    t: z.literal('join'),
    rendezvousId: RendezvousId,
    from: Extension,
  })
  .strict();
export type JoinFrame = z.infer<typeof JoinFrame>;

export const SendFrame = z
  .object({
    t: z.literal('send'),
    callId: CallId,
    frame: SealedFrame,
  })
  .strict();
export type SendFrame = z.infer<typeof SendFrame>;

export const HangupFrame = z
  .object({
    t: z.literal('hangup'),
    callId: CallId,
    reason: z.string().max(500).optional(),
  })
  .strict();
export type HangupFrame = z.infer<typeof HangupFrame>;

/** Discriminated union of everything a client may send. */
export const ClientFrame = z.discriminatedUnion('t', [
  OpenFrame,
  JoinFrame,
  SendFrame,
  HangupFrame,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---- Relay -> Client ----------------------------------------------------

export type ServerFrame =
  | { t: 'opened'; callId: string }
  | { t: 'joined'; callId: string; peer: string }
  | { t: 'peer-joined'; callId: string; peer: string }
  | { t: 'deliver'; callId: string; frame: string }
  | { t: 'hangup'; callId: string; reason: string }
  | { t: 'error'; code: ErrorCode; message: string };

/** Stable machine-readable error codes carried on `{ t:'error' }` frames. */
export type ErrorCode =
  | 'BAD_FRAME'
  | 'UNKNOWN_RENDEZVOUS'
  | 'EXPIRED'
  | 'ALREADY_PAIRED'
  | 'NOT_PARTICIPANT'
  | 'UNKNOWN_CALL'
  | 'CALL_CLOSED'
  | 'TURN_CAP'
  | 'PEER_GONE';
