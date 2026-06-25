import { z } from 'zod';
import { MAX_CONTENT_BYTES, PROTOCOL_VERSION } from './constants.js';

/**
 * An extension is a human-readable agent address: `@<owner>/<role>`.
 * e.g. `@chris/impl`, `@sora/strategy`.
 *
 * STRICT by construction — this regex is the first line of defense against
 * the path-traversal / id-spoofing vuln class found in prior art
 * (ids must never be interpolated into filesystem paths unvalidated).
 */
export const EXTENSION_RE = /^@[a-z0-9](?:[a-z0-9-]{0,30})\/[a-z0-9](?:[a-z0-9-]{0,30})$/;
export const Extension = z.string().regex(EXTENSION_RE, 'invalid extension; expected @owner/role');
export type Extension = z.infer<typeof Extension>;

export const MessageId = z.string().regex(/^msg-[A-Za-z0-9_-]{10,}$/);
export const CallId = z.string().regex(/^call-[A-Za-z0-9_-]{10,}$/);

export const MessageType = z.enum(['query', 'response', 'ping', 'hangup', 'system', 'resolve']);
export type MessageType = z.infer<typeof MessageType>;

/**
 * The canonical wire message. Deliberately close to the prior-art contract
 * (id/from/to/type/inReplyTo/status/content) so the conformance corpus ports
 * cleanly — but with strict validation and a turn counter for termination.
 */
export const Message = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    id: MessageId,
    callId: CallId,
    from: Extension,
    to: Extension,
    type: MessageType,
    ts: z.string().datetime(),
    turn: z.number().int().nonnegative(),
    inReplyTo: MessageId.nullable(),
    /** Caller-supplied text. ALWAYS treated as untrusted data by receivers — see security.ts. */
    content: z
      .string()
      .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_CONTENT_BYTES, {
        message: `content exceeds ${MAX_CONTENT_BYTES} bytes`,
      }),
  })
  .strict();
export type Message = z.infer<typeof Message>;

/** A call is a single tracked exchange between exactly two extensions. */
export const CallState = z.enum(['open', 'answered', 'closed']);
export type CallState = z.infer<typeof CallState>;

export const Call = z
  .object({
    id: CallId,
    topic: z.string().max(2000),
    participants: z.tuple([Extension, Extension]),
    state: CallState,
    turn: z.number().int().nonnegative(),
    maxTurns: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Call = z.infer<typeof Call>;

/** Parse + validate an inbound wire frame. Throws on anything malformed. */
export function parseMessage(raw: unknown): Message {
  return Message.parse(raw);
}

/**
 * How a call ended. `resolved` is the good outcome — an agent declared the
 * matter settled and supplied a summary. The rest are non-resolutions.
 */
export const CallOutcome = z.enum(['resolved', 'turn-cap', 'hung-up', 'disconnected']);
export type CallOutcome = z.infer<typeof CallOutcome>;

/** One line of a call transcript (decrypted, from this side's point of view). */
export interface TranscriptEntry {
  from: Extension;
  type: MessageType;
  content: string;
  ts: string;
}

/**
 * The artifact handed to a human when a call ends: the outcome, the agent's
 * summary (if it resolved), and the full transcript. Persisted locally so an
 * away human can read it later — this is the "report on termination" the whole
 * async value proposition depends on.
 */
export interface CallReport {
  callId: string;
  topic: string;
  me: Extension;
  peer: Extension | null;
  outcome: CallOutcome;
  /** The resolution summary; present iff outcome === 'resolved'. */
  summary: string | null;
  turns: number;
  startedAt: string;
  endedAt: string;
  transcript: TranscriptEntry[];
}
