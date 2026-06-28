import { newMessageId, PROTOCOL_VERSION } from '@switchboard/protocol';
import type { Extension, Message } from '@switchboard/protocol';
import type { CallTransport } from './auto-attendant.js';
import { TypedEmitter } from './events.js';

/**
 * The DRIVER half of an autonomous agent↔agent exchange. Where {@link AutoAttendant}
 * answers a peer's questions, the AutoDriver *initiates and pushes a goal to
 * agreement*: it opens with a question, evaluates each reply against its OWN
 * context, pushes back when unsatisfied, and declares agreement (resolve) only
 * when the goal is met — the multi-turn convergence that is the whole point of
 * the tool (a one-shot Q&A wouldn't need it).
 */

/** One step's decision: say something more, or declare agreement. */
export type DriverDecision =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'agree'; readonly summary: string };

export interface DriverInput {
  /** The goal the driver is pushing to resolution (from its operator). */
  readonly goal: string;
  /** The driver's own project root — the spec/context it judges replies against. */
  readonly cwd: string;
  /** The conversation so far, oldest first. */
  readonly transcript: ReadonlyArray<{ readonly from: 'me' | 'peer'; readonly text: string }>;
}

/** The vendor-pluggable brain that drives one step. */
export interface DriverBrain {
  readonly id: string;
  step(input: DriverInput): Promise<DriverDecision>;
}

export type DriverEscalateReason = 'turn-cap' | 'brain-error' | 'peer-hangup';

export interface DriverEvents extends Record<string, unknown> {
  /** The driver concluded the goal was met. */
  agreed: { callId: string; summary: string };
  /** A message was sent to the peer. */
  said: { callId: string; text: string };
  /** Stopped without agreement; a human should take over. */
  escalate: { callId: string; reason: DriverEscalateReason; detail: string };
}

export interface AutoDriverOptions {
  readonly self: Extension;
  readonly peer: Extension;
  readonly callId: string;
  readonly cwd: string;
  readonly goal: string;
  readonly brain: DriverBrain;
  readonly transport: CallTransport;
  /** Hard cap on driver turns before escalating (safety backstop). */
  readonly maxTurns: number;
}

export class AutoDriver extends TypedEmitter<DriverEvents> {
  readonly #self: Extension;
  readonly #peer: Extension;
  readonly #callId: string;
  readonly #cwd: string;
  readonly #goal: string;
  readonly #brain: DriverBrain;
  readonly #transport: CallTransport;
  readonly #maxTurns: number;

  readonly #transcript: { from: 'me' | 'peer'; text: string }[] = [];
  #turns = 0;
  #done = false;

  constructor(opts: AutoDriverOptions) {
    super();
    this.#self = opts.self;
    this.#peer = opts.peer;
    this.#callId = opts.callId;
    this.#cwd = opts.cwd;
    this.#goal = opts.goal;
    this.#brain = opts.brain;
    this.#transport = opts.transport;
    this.#maxTurns = opts.maxTurns;
  }

  /** Wire the transport and make the opening move. Call once the peer has joined. */
  async start(): Promise<void> {
    this.#transport.onMessage((msg) => {
      void this.#onPeer(msg);
    });
    this.#transport.onHangup((reason) => {
      if (this.#done) return;
      this.#done = true;
      this.emit('escalate', { callId: this.#callId, reason: 'peer-hangup', detail: reason });
    });
    await this.#drive();
  }

  async #onPeer(msg: Message): Promise<void> {
    if (this.#done) return;
    if (msg.callId !== this.#callId) return;
    if (msg.from === this.#self) return;
    // The peer's resolve/hangup is handled via onHangup; only real replies drive us.
    if (msg.type !== 'response' && msg.type !== 'query') return;
    this.#transcript.push({ from: 'peer', text: msg.content });
    await this.#drive();
  }

  /** Ask the brain for the next move and act on it. */
  async #drive(): Promise<void> {
    if (this.#done) return;

    if (this.#turns >= this.#maxTurns) {
      this.#done = true;
      await this.#transport.hangup(this.#callId);
      this.emit('escalate', {
        callId: this.#callId,
        reason: 'turn-cap',
        detail: `turn cap (${this.#maxTurns}) reached without agreement`,
      });
      return;
    }

    let decision: DriverDecision;
    try {
      decision = await this.#brain.step({ goal: this.#goal, cwd: this.#cwd, transcript: this.#transcript });
    } catch (err) {
      this.#done = true;
      await this.#transport.hangup(this.#callId);
      this.emit('escalate', { callId: this.#callId, reason: 'brain-error', detail: String(err) });
      return;
    }

    if (decision.kind === 'agree') {
      this.#done = true;
      await this.#transport.resolve(this.#callId, decision.summary);
      this.emit('agreed', { callId: this.#callId, summary: decision.summary });
      return;
    }

    // say: send a query to the peer and record it.
    this.#turns += 1;
    this.#transcript.push({ from: 'me', text: decision.text });
    const msg: Message = {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: this.#callId,
      from: this.#self,
      to: this.#peer,
      type: 'query',
      ts: new Date().toISOString(),
      turn: this.#turns,
      inReplyTo: null,
      content: decision.text,
    };
    await this.#transport.send(this.#callId, msg);
    this.emit('said', { callId: this.#callId, text: decision.text });
  }
}
