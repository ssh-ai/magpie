import { MagpieClient } from '@magpie/client';
import {
  newMessageId,
  parseInvite,
  PROTOCOL_VERSION,
  DEFAULT_MAX_TURNS,
} from '@magpie/protocol';
import type { CallReport, Extension, Message, MessageType } from '@magpie/protocol';

/**
 * Session layer that sits between the MCP tools and the raw MagpieClient.
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

/** Actionable hint when no relay URL is available for an operation. */
const NO_RELAY_HINT =
  'set MAGPIE_RELAY_URL or pass relayUrl (joiners can instead paste a full ' +
  'invite like CODE@ws://relay-host:8787)';

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

  readonly #client: MagpieClient;
  readonly #askTimeoutMs: number;

  constructor(opts: {
    client: MagpieClient;
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

  /**
   * The relay client this session lives on. Sessions remember their client
   * because the store may hold connections to SEVERAL relays (invite-carried
   * URLs), and dispatch/teardown must target only the right one.
   */
  get client(): MagpieClient {
    return this.#client;
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
 * Owns the relay connections and the set of live CallSessions. The MCP tools
 * talk only to this store.
 *
 * One MCP process represents one endpoint identity (`self`), but it may talk
 * to SEVERAL relays: the env-configured default plus any relay carried inside
 * an invite token (`CODE@ws://…`). Clients are therefore keyed by relay URL
 * and connected lazily; each CallSession remembers which client it lives on.
 * Inbound deliveries and hangups are fanned out per client, to the matching
 * session by callId.
 */
export class SessionStore {
  readonly self: Extension;
  readonly #defaultRelayUrl: string | null;
  readonly #askTimeoutMs: number | undefined;
  readonly #connect: (url: string) => Promise<MagpieClient>;

  /** Lazily-connected clients keyed by relay URL (memoized promises). */
  readonly #clients = new Map<string, Promise<MagpieClient>>();

  readonly #sessions = new Map<string, CallSession>();

  constructor(opts: {
    self: Extension;
    /** Default relay (env MAGPIE_RELAY_URL). Null = invite-carried URLs only. */
    relayUrl?: string | null;
    askTimeoutMs?: number;
    /** Test seam: how to open a relay connection. Defaults to MagpieClient.connect. */
    connect?: (url: string) => Promise<MagpieClient>;
  }) {
    this.self = opts.self;
    this.#defaultRelayUrl = opts.relayUrl ?? null;
    this.#askTimeoutMs = opts.askTimeoutMs;
    this.#connect = opts.connect ?? ((url) => MagpieClient.connect(url));
  }

  /** The default relay URL from configuration, if any (used to compose invites). */
  get relayUrl(): string | null {
    return this.#defaultRelayUrl;
  }

  /** Lazily connect to `url` (once per URL) and wire the dispatch handlers. */
  #ensureClient(url: string): Promise<MagpieClient> {
    const existing = this.#clients.get(url);
    if (existing) return existing;

    const connecting = this.#connect(url).then((client) => {
      client.onMessage((msg) => {
        const session = this.#sessions.get(msg.callId);
        if (session) session.ingest(msg);
      });
      client.onHangup((reason) => {
        // The wire-level hangup frame doesn't carry a callId in onHangup's
        // signature; close every session ON THIS CLIENT defensively. In
        // practice a relay hangup targets a specific call, but failing safe
        // is correct — and it must not leak across relays.
        for (const s of this.#sessions.values()) {
          if (s.client === client) s.markClosed(reason);
        }
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
      return client;
    });
    // A failed connect must not poison the cache — allow a retry next call.
    connecting.catch(() => this.#clients.delete(url));
    this.#clients.set(url, connecting);
    return connecting;
  }

  /** Resolve which relay a call should use, with a clear config error. */
  #resolveRelay(override: string | null | undefined, context: string): string {
    const url = override ?? this.#defaultRelayUrl;
    if (!url) throw new Error(`no relay configured for ${context}: ${NO_RELAY_HINT}`);
    return url;
  }

  /**
   * Start a new call; returns the session whose `.code` is shown to the human.
   * `relayUrl` (if given) overrides the configured default for this call.
   */
  async start(topic: string, maxTurns?: number, relayUrl?: string): Promise<CallSession> {
    const url = this.#resolveRelay(relayUrl, 'sb_start');
    const client = await this.#ensureClient(url);
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

  /**
   * Join an existing call by invite (`CODE@ws://relay`) or bare pairing code.
   * An invite-carried relay URL wins over the configured default, so a joiner
   * needs NO relay configuration when handed a full invite.
   */
  async join(inviteOrCode: string): Promise<CallSession> {
    const invite = parseInvite(inviteOrCode);
    const url = this.#resolveRelay(invite.relayUrl, 'sb_join with a bare code');
    const client = await this.#ensureClient(url);
    const joined = await client.join({ from: this.self, code: invite.code });
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

  /** Close every relay connection and drop all call state. */
  close(): void {
    for (const s of this.#sessions.values()) s.markClosed('store closed');
    this.#sessions.clear();
    for (const pending of this.#clients.values()) {
      void pending.then((c) => c.close()).catch(() => {});
    }
    this.#clients.clear();
  }
}

export { DEFAULT_MAX_TURNS };
