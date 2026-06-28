import { SwitchboardClient } from '@switchboard/client';
import {
  newMessageId,
  PROTOCOL_VERSION,
  DEFAULT_MAX_TURNS,
} from '@switchboard/protocol';
import type { CallReport, Extension, Message, MessageType } from '@switchboard/protocol';

/**
 * Session layer that sits between the MCP tools and the raw SwitchboardClient.
 *
 * The MCP tools are stateless request/response shaped (a host model calls
 * `sb_ask` and expects the peer's answer back in the SAME tool result), but the
 * wire is async and bidirectional. This layer bridges the two:
 *
 *   - it correlates an outbound `query` to the inbound `response` whose
 *     `inReplyTo` matches, so `sb_ask` can await the answer;
 *   - it queues inbound `query` messages so `sb_listen` can hand them to the
 *     host model one at a time;
 *   - it tracks remote hangups so tools fail loudly instead of hanging.
 *
 * Security note: this layer NEVER renders peer content. It carries raw
 * `Message` objects. Anything that becomes model-visible text is fenced via
 * `renderInbound` at the tool boundary (see tools.ts). Keeping the fence at one
 * choke point is deliberate.
 */

/** A pending `sb_ask` awaiting the peer's reply, keyed by the query's message id. */
interface AwaitedReply {
  resolve: (msg: Message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionInfo {
  callId: string;
  /** This endpoint's extension address. */
  self: Extension;
  /** The peer's extension address, once known (after join / peer-joined). */
  peer: Extension | null;
  /** Human-shareable pairing code — present only on the side that called start. */
  code: string | null;
  topic: string;
  /** Monotonic local turn counter; stamped onto every outbound message. */
  turn: number;
  closed: boolean;
  closedReason: string | null;
}

/** How long `sb_ask` waits for the peer's answer before giving up. */
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * One open call. Wraps the shared client with this call's identity, an inbound
 * query queue, and reply correlation.
 */
export class CallSession {
  readonly callId: string;
  readonly self: Extension;
  readonly topic: string;
  readonly code: string | null;

  peer: Extension | null;

  #turn = 0;
  #closed = false;
  #closedReason: string | null = null;

  /** Inbound peer `query` messages not yet handed to the host model. */
  readonly #inbound: Message[] = [];
  /** A parked `sb_listen` waiting for the next inbound query (at most one). */
  #waitingListener: ((msg: Message) => void) | null = null;

  /** Outstanding `sb_ask` calls keyed by the query message id we are awaiting a reply to. */
  readonly #awaiting = new Map<string, AwaitedReply>();

  readonly #client: SwitchboardClient;
  readonly #askTimeoutMs: number;

  constructor(opts: {
    client: SwitchboardClient;
    callId: string;
    self: Extension;
    peer: Extension | null;
    topic: string;
    code: string | null;
    askTimeoutMs?: number;
  }) {
    this.#client = opts.client;
    this.callId = opts.callId;
    this.self = opts.self;
    this.peer = opts.peer;
    this.topic = opts.topic;
    this.code = opts.code;
    this.#askTimeoutMs = opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  }

  get closed(): boolean {
    return this.#closed;
  }

  info(): SessionInfo {
    return {
      callId: this.callId,
      self: this.self,
      peer: this.peer,
      code: this.code,
      topic: this.topic,
      turn: this.#turn,
      closed: this.#closed,
      closedReason: this.#closedReason,
    };
  }

  /** Route a decrypted inbound message belonging to this call. */
  ingest(msg: Message): void {
    // A reply to one of our outstanding asks?
    if (msg.type === 'response' && msg.inReplyTo) {
      const waiter = this.#awaiting.get(msg.inReplyTo);
      if (waiter) {
        this.#awaiting.delete(msg.inReplyTo);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
      // Unmatched response (e.g. ask already timed out) — queue so a listener
      // can still surface it rather than silently dropping peer content.
    }

    if (msg.type === 'query' || msg.type === 'response') {
      // Hand directly to a parked listener if one is waiting; else queue.
      const listener = this.#waitingListener;
      if (listener) {
        this.#waitingListener = null;
        listener(msg);
      } else {
        this.#inbound.push(msg);
      }
    }
    // ping / system / hangup are control-plane; not surfaced to the model here.
  }

  /** Mark the call as closed and fail anything in flight. */
  markClosed(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closedReason = reason;
    const err = new Error(`call ${this.callId} closed: ${reason}`);
    for (const [, w] of this.#awaiting) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.#awaiting.clear();
    if (this.#waitingListener) {
      // Unpark with a synthetic hangup marker so sb_listen returns instead of hanging.
      const listener = this.#waitingListener;
      this.#waitingListener = null;
      listener(this.#hangupMarker(reason));
    }
  }

  /**
   * Send a `query` to the peer and resolve with their matching `response`.
   * Used by `sb_ask`. Rejects on timeout, hangup, or send failure.
   */
  async ask(question: string): Promise<Message> {
    this.#assertOpen();
    const id = newMessageId();
    const query = this.#build(id, 'query', question, null);

    const reply = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#awaiting.delete(id);
        reject(new Error(`timed out waiting for peer reply to ${id}`));
      }, this.#askTimeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.#awaiting.set(id, { resolve, reject, timer });
    });

    try {
      await this.#client.send(this.callId, query);
    } catch (err) {
      const w = this.#awaiting.get(id);
      if (w) {
        clearTimeout(w.timer);
        this.#awaiting.delete(id);
      }
      throw err;
    }
    return reply;
  }

  /**
   * Return the next inbound peer message (query or unmatched response),
   * removing it from the queue. Resolves immediately if one is buffered,
   * otherwise parks until one arrives or the call closes.
   * Used by `sb_listen`. `null` means "no inbound and the call is closed".
   */
  nextInbound(timeoutMs?: number): Promise<Message | null> {
    const buffered = this.#inbound.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.#closed) return Promise.resolve(null);

    return new Promise<Message | null>((resolve) => {
      let settled = false;
      const done = (m: Message | null) => {
        if (settled) return;
        settled = true;
        if (this.#waitingListener === deliver) this.#waitingListener = null;
        clearTimeout(timer);
        resolve(m);
      };
      const deliver = (m: Message) => {
        // A hangup marker means the call closed while we were parked.
        if (m.type === 'hangup') done(null);
        else done(m);
      };
      // Only one parked listener at a time; replace any prior parked one.
      this.#waitingListener = deliver;
      const timer = setTimeout(
        () => done(null),
        timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
      );
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });
  }

  /** Send a `response` to a specific inbound query. Used by `sb_answer`. */
  async answer(inReplyTo: string, text: string): Promise<Message> {
    this.#assertOpen();
    const id = newMessageId();
    const msg = this.#build(id, 'response', text, inReplyTo);
    await this.#client.send(this.callId, msg);
    return msg;
  }

  /**
   * Declare a FIRM CONCLUSION reached with the peer: sends a `resolve` message
   * (carrying `summary`) so the peer learns the conclusion, ends the call, and
   * returns the end-of-call report built from the transcript. Used by
   * `sb_resolve`. This is the autonomous agree-loop's terminal move — call it
   * once nothing is left to resolve (agreement, or a firm pass/fail verdict).
   */
  async resolve(summary: string): Promise<CallReport | null> {
    this.#assertOpen();
    await this.#client.resolve(this.callId, summary);
    const report = this.#client.buildReport(this.callId, 'resolved');
    this.markClosed('resolved');
    return report;
  }

  /**
   * The PEER declared the call resolved. Surface their summary to a parked (or
   * next) `sb_listen` so the local agent can report the conclusion to its human,
   * then close. Wired from the client's `onResolved` by the SessionStore.
   */
  markResolved(summary: string): void {
    if (this.#closed) return;
    const marker = this.#resolveMarker(summary);
    const listener = this.#waitingListener;
    if (listener) {
      this.#waitingListener = null;
      listener(marker);
    } else {
      this.#inbound.push(marker);
    }
    this.markClosed('resolved');
  }

  /** Tear down this call on the wire. */
  async hangup(): Promise<void> {
    if (!this.#closed) {
      try {
        await this.#client.hangup(this.callId);
      } finally {
        this.markClosed('local hangup');
      }
    }
  }

  // ---- internals -----------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(
        `call ${this.callId} is closed${this.#closedReason ? ` (${this.#closedReason})` : ''}`,
      );
    }
    if (!this.peer) {
      throw new Error(
        `call ${this.callId} has no peer yet; the other party must sb_join with the code first`,
      );
    }
  }

  #build(
    id: string,
    type: MessageType,
    content: string,
    inReplyTo: string | null,
  ): Message {
    // peer is guaranteed non-null by #assertOpen for query/response paths.
    const to = this.peer ?? this.self;
    this.#turn += 1;
    return {
      v: PROTOCOL_VERSION,
      id,
      callId: this.callId,
      from: this.self,
      to,
      type,
      ts: new Date().toISOString(),
      turn: this.#turn,
      inReplyTo,
      content,
    };
  }

  /** Synthetic, never-sent marker carrying the peer's resolution summary. */
  #resolveMarker(summary: string): Message {
    return {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: this.callId,
      from: this.peer ?? this.self,
      to: this.self,
      type: 'resolve',
      ts: new Date().toISOString(),
      turn: this.#turn,
      inReplyTo: null,
      content: summary,
    };
  }

  /** Synthetic, never-sent marker used only to unpark a waiting listener. */
  #hangupMarker(reason: string): Message {
    return {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: this.callId,
      from: this.peer ?? this.self,
      to: this.self,
      type: 'hangup',
      ts: new Date().toISOString(),
      turn: this.#turn,
      inReplyTo: null,
      content: reason,
    };
  }
}

/**
 * Owns the single shared SwitchboardClient connection and the set of live
 * CallSessions. The MCP tools talk only to this store.
 *
 * The relay correlates by connection, and one MCP process represents one
 * endpoint identity (`self`), so a single client + a callId-keyed session map
 * is the right shape. Inbound deliveries and hangups are fanned out to the
 * matching session by callId.
 */
export class SessionStore {
  readonly self: Extension;
  readonly #relayUrl: string;
  readonly #askTimeoutMs: number | undefined;

  #client: SwitchboardClient | null = null;
  #connecting: Promise<SwitchboardClient> | null = null;

  readonly #sessions = new Map<string, CallSession>();

  constructor(opts: { self: Extension; relayUrl: string; askTimeoutMs?: number }) {
    this.self = opts.self;
    this.#relayUrl = opts.relayUrl;
    this.#askTimeoutMs = opts.askTimeoutMs;
  }

  /** Lazily connect to the relay (once) and wire the global dispatch handlers. */
  async #ensureClient(): Promise<SwitchboardClient> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;

    this.#connecting = SwitchboardClient.connect(this.#relayUrl).then((client) => {
      client.onMessage((msg) => {
        const session = this.#sessions.get(msg.callId);
        if (session) session.ingest(msg);
      });
      client.onHangup((reason) => {
        // The wire-level hangup frame doesn't carry a callId in onHangup's
        // signature; close every session defensively. In practice a relay
        // hangup targets a specific call, but failing safe is correct.
        for (const s of this.#sessions.values()) s.markClosed(reason);
      });
      client.onPeerJoined((callId, peer) => {
        // The opener learns who joined; record it so sb_ask/sb_answer can
        // address outbound messages even before the peer sends anything.
        const session = this.#sessions.get(callId);
        if (session) session.peer = peer;
      });
      client.onResolved((callId, summary) => {
        // The peer concluded the call; surface the summary to sb_listen so the
        // local agent can report it, then close the session.
        const session = this.#sessions.get(callId);
        if (session) session.markResolved(summary);
      });
      this.#client = client;
      this.#connecting = null;
      return client;
    });
    return this.#connecting;
  }

  /** Start a new call; returns the session whose `.code` is shown to the human. */
  async start(topic: string, maxTurns?: number): Promise<CallSession> {
    const client = await this.#ensureClient();
    const opened = await client.start({
      from: this.self,
      topic,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    });
    const session = new CallSession({
      client,
      callId: opened.callId,
      self: this.self,
      peer: null, // learned when the peer joins
      topic,
      code: opened.code,
      ...(this.#askTimeoutMs !== undefined ? { askTimeoutMs: this.#askTimeoutMs } : {}),
    });
    this.#sessions.set(session.callId, session);
    return session;
  }

  /** Join an existing call by its pairing code. */
  async join(code: string): Promise<CallSession> {
    const client = await this.#ensureClient();
    const joined = await client.join({ from: this.self, code });
    const session = new CallSession({
      client,
      callId: joined.callId,
      self: this.self,
      peer: joined.peer,
      topic: '(joined)',
      code: null,
      ...(this.#askTimeoutMs !== undefined ? { askTimeoutMs: this.#askTimeoutMs } : {}),
    });
    this.#sessions.set(session.callId, session);
    return session;
  }

  /** Look up a live session, throwing a clear error if absent. */
  require(callId: string): CallSession {
    const s = this.#sessions.get(callId);
    if (!s) {
      throw new Error(
        `unknown callId ${JSON.stringify(callId)}; call sb_start or sb_join first`,
      );
    }
    return s;
  }

  /** Hang up and forget a call. */
  async hangup(callId: string): Promise<void> {
    const s = this.#sessions.get(callId);
    if (!s) return;
    await s.hangup();
    this.#sessions.delete(callId);
  }

  /** Drop a call from the map without re-hanging-up (already closed/resolved). */
  forget(callId: string): void {
    this.#sessions.delete(callId);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info());
  }

  /** Close the relay connection and drop all call state. */
  close(): void {
    for (const s of this.#sessions.values()) s.markClosed('store closed');
    this.#sessions.clear();
    this.#client?.close();
    this.#client = null;
  }
}

export { DEFAULT_MAX_TURNS };
