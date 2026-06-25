import {
  DEFAULT_ACTION_POLICY,
  gateAction,
  newMessageId,
  PROTOCOL_VERSION,
} from '@switchboard/protocol';
import type { ActionPolicy, Extension, Message } from '@switchboard/protocol';
import type { Responder } from './responder.js';
import { TypedEmitter } from './events.js';

/**
 * The subset of @switchboard/client the attendant needs. Declaring it as an
 * interface (rather than depending on the concrete class) keeps the worker
 * testable with a fake transport and decoupled from connection lifecycle.
 */
export interface CallTransport {
  onMessage(cb: (msg: Message) => void): void;
  onHangup(cb: (reason: string) => void): void;
  send(callId: string, msg: Message): Promise<void>;
  hangup(callId: string): Promise<void>;
}

/** Why the attendant stopped answering and handed off to the human. */
export type EscalateReason =
  | 'low-confidence'
  | 'action-blocked'
  | 'turn-cap'
  | 'responder-error';

export interface EscalateEvent {
  readonly callId: string;
  readonly reason: EscalateReason;
  /** Human-readable detail for the page/notification. */
  readonly detail: string;
  /** The peer question that triggered escalation, if any. */
  readonly question?: string;
}

export interface AnsweredEvent {
  readonly callId: string;
  readonly question: string;
  readonly answer: string;
}

export interface AutoAttendantEvents extends Record<string, unknown> {
  escalate: EscalateEvent;
  answered: AnsweredEvent;
}

export interface AutoAttendantOptions {
  /** This attendant's own address, used as `from` on outgoing answers. */
  readonly self: Extension;
  /** The call this attendant is staffing. */
  readonly callId: string;
  /** Local project root the responder may read from. */
  readonly cwd: string;
  /** The call topic (lives on the Call, not the Message). Passed to the responder as context. */
  readonly topic: string;
  /** The vendor-pluggable brain. */
  readonly responder: Responder;
  /** The connected transport (e.g. a SwitchboardClient). */
  readonly transport: CallTransport;
  /**
   * Hard cap on answered turns before auto-hangup + escalate. Mirrors the call's
   * `maxTurns`; the relay also enforces its own ceiling.
   */
  readonly maxTurns: number;
  /** Action policy. Defaults to DEFAULT_ACTION_POLICY (readOwnFiles, no tools). */
  readonly policy?: ActionPolicy;
}

/**
 * Headless "answer on your behalf" worker.
 *
 * Lifecycle: {@link start} wires the transport callbacks; thereafter every
 * inbound `query` is handled by {@link handleQuery}. The attendant:
 *
 *   1. Gates the action under the policy (DEFAULT_ACTION_POLICY: read own files,
 *      NO tools). If the gate would block, it does NOT guess — it escalates.
 *   2. Runs the {@link Responder} against the project `cwd`.
 *   3. If the responder is `!confident` (or errors), it escalates instead of
 *      shipping a guess.
 *   4. Otherwise it sends the answer back over the call.
 *   5. Respects the turn cap: at the cap it hangs up and escalates.
 *
 * "Escalate" means: hang up the call with a reason and emit an `escalate` event
 * so a human can take over. The model's uncertainty is treated as a STOP, never
 * a license to bluff.
 */
export class AutoAttendant extends TypedEmitter<AutoAttendantEvents> {
  readonly #self: Extension;
  readonly #callId: string;
  readonly #cwd: string;
  readonly #topic: string;
  readonly #responder: Responder;
  readonly #transport: CallTransport;
  readonly #maxTurns: number;
  readonly #policy: ActionPolicy;

  /** Answered turns so far. One inbound query that we answer === one turn. */
  #turns = 0;
  #done = false;

  constructor(opts: AutoAttendantOptions) {
    super();
    this.#self = opts.self;
    this.#callId = opts.callId;
    this.#cwd = opts.cwd;
    this.#topic = opts.topic;
    this.#responder = opts.responder;
    this.#transport = opts.transport;
    this.#maxTurns = opts.maxTurns;
    this.#policy = opts.policy ?? DEFAULT_ACTION_POLICY;
  }

  /** Wire up the transport. Call once after the call is joined. */
  start(): void {
    this.#transport.onMessage((msg) => {
      void this.#onMessage(msg);
    });
    this.#transport.onHangup((reason) => {
      // Peer (or relay) hung up; we're done. No escalation needed.
      this.#done = true;
      void reason;
    });
  }

  async #onMessage(msg: Message): Promise<void> {
    if (this.#done) return;
    if (msg.callId !== this.#callId) return;
    // Only inbound questions drive the attendant. Ignore our own echoes,
    // responses, pings, and system frames.
    if (msg.type !== 'query') return;
    if (msg.from === this.#self) return;
    await this.handleQuery(msg);
  }

  /**
   * Handle a single inbound query end-to-end. Exposed (not private) so it can be
   * unit-tested directly with a synthetic Message, no transport wiring required.
   */
  async handleQuery(msg: Message): Promise<void> {
    if (this.#done) return;

    // Turn cap: if we are already at the cap, do not answer again. Hang up +
    // escalate so the human takes the next turn.
    if (this.#turns >= this.#maxTurns) {
      await this.#escalate('turn-cap', `turn cap (${this.#maxTurns}) reached`, msg);
      return;
    }

    // Gate the action under policy. The auto-attendant only ever needs to read
    // its OWN files; it must never run tools on a peer's say-so. If the gate
    // would block, we escalate rather than guess.
    const gate = gateAction('readOwnFiles', this.#policy);
    if (!gate.allowed) {
      await this.#escalate('action-blocked', gate.reason, msg);
      return;
    }

    let confident: boolean;
    let text: string;
    try {
      const result = await this.#responder.answer({
        question: msg.content,
        topic: this.#topic,
        cwd: this.#cwd,
      });
      confident = result.confident;
      text = result.text;
    } catch (err) {
      await this.#escalate('responder-error', String(err), msg);
      return;
    }

    // The core rule: low confidence is a STOP, not a bluff. Escalate.
    if (!confident) {
      await this.#escalate('low-confidence', 'responder was not confident', msg);
      return;
    }

    this.#turns += 1;
    const reply: Message = {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: this.#callId,
      from: this.#self,
      to: msg.from,
      type: 'response',
      ts: new Date().toISOString(),
      turn: msg.turn + 1,
      inReplyTo: msg.id,
      content: text,
    };
    await this.#transport.send(this.#callId, reply);
    this.emit('answered', { callId: this.#callId, question: msg.content, answer: text });
  }

  /** Hang up with a reason and page the human. Idempotent. */
  async #escalate(reason: EscalateReason, detail: string, msg?: Message): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    const event: EscalateEvent = msg
      ? { callId: this.#callId, reason, detail, question: msg.content }
      : { callId: this.#callId, reason, detail };
    try {
      await this.#transport.hangup(this.#callId);
    } finally {
      this.emit('escalate', event);
    }
  }
}
