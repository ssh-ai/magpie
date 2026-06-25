import WebSocket from 'ws';
import {
  parseMessage,
  rendezvousId,
  channelFromCode,
  generatePairingCode,
  newMessageId,
  MAX_CONTENT_BYTES,
  DEFAULT_MAX_TURNS,
  ABSOLUTE_MAX_TURNS,
  PROTOCOL_VERSION,
} from '@switchboard/protocol';
import type {
  Extension,
  Message,
  PairingChannel,
  CallReport,
  CallOutcome,
  TranscriptEntry,
} from '@switchboard/protocol';
import type {
  ClientToRelay,
  OpenFrame,
  OpenedFrame,
  JoinedFrame,
  ErrorFrame,
} from './wire.js';
import { parseRelayFrame } from './wire.js';

type MessageCb = (msg: Message) => void;
type HangupCb = (reason: string) => void;
type PeerJoinedCb = (callId: string, peer: Extension) => void;
type ResolvedCb = (callId: string, summary: string) => void;

/** Per-call bookkeeping for transcript + report building. */
interface CallCtx {
  from: Extension;
  peer: Extension | null;
  topic: string;
  startedAt: string;
  transcript: TranscriptEntry[];
  /** Set when a `resolve` message is sent or received. */
  summary: string | null;
}

/** A request awaiting its matching relay reply, correlated by reply type. */
interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

/**
 * @switchboard/client — a thin WebSocket client to the relay plus the per-call
 * pairing crypto.
 *
 * The relay sees CIPHERTEXT ONLY: every `Message` is JSON-serialized, sealed
 * with the call's `PairingChannel`, base64-encoded, and shipped as an opaque
 * `frame`. The channel for a call is held here, keyed by callId, and is the
 * ONLY thing that can read peer payloads.
 */
export class SwitchboardClient {
  readonly #ws: WebSocket;

  /** Per-call E2E channel. The relay can never produce one of these. */
  readonly #channels = new Map<string, PairingChannel>();

  /** Per-call transcript + metadata, for building the end-of-call report. */
  readonly #ctx = new Map<string, CallCtx>();

  readonly #messageCbs: MessageCb[] = [];
  readonly #hangupCbs: HangupCb[] = [];
  readonly #peerJoinedCbs: PeerJoinedCb[] = [];
  readonly #resolvedCbs: ResolvedCb[] = [];

  /**
   * Pending open/join requests. The relay correlates replies by connection
   * order (no request id on the wire), so we queue FIFO per reply type.
   */
  readonly #pendingOpen: Pending<OpenedFrame>[] = [];
  readonly #pendingJoin: Pending<JoinedFrame>[] = [];

  /**
   * The channel a join/open is about to be associated with, queued alongside
   * the pending request so the callId from the relay reply can be bound to it.
   */
  readonly #pendingChannel: PairingChannel[] = [];

  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data) => this.#onWireData(data));
    ws.on('close', () => this.#onClose('connection closed'));
    ws.on('error', (err) => this.#onClose(`connection error: ${String(err)}`));
  }

  /** Open a WebSocket to the relay and resolve once it is ready. */
  static connect(relayUrl: string): Promise<SwitchboardClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl);
      const onError = (err: Error) => {
        ws.removeAllListeners();
        reject(err);
      };
      ws.once('error', onError);
      ws.once('open', () => {
        ws.removeListener('error', onError);
        resolve(new SwitchboardClient(ws));
      });
    });
  }

  /**
   * Open a new call. Mints a fresh pairing code, derives the per-call channel,
   * and tells the relay to register the rendezvous. Returns the human-shareable
   * code, the callId, and the channel (also retained internally).
   */
  async start(opts: {
    from: Extension;
    topic: string;
    maxTurns?: number;
  }): Promise<{ code: string; callId: string; channel: PairingChannel }> {
    const code = generatePairingCode();
    const channel = channelFromCode(code);

    // Clamp client-side too; the relay re-clamps, but never send nonsense.
    const requested = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxTurns = Math.max(1, Math.min(requested, ABSOLUTE_MAX_TURNS));

    const send: OpenFrame = {
      t: 'open',
      rendezvousId: rendezvousId(code),
      from: opts.from,
      topic: opts.topic,
      maxTurns,
    };

    const opened = await this.#request<OpenedFrame>(this.#pendingOpen, channel, send);
    this.#channels.set(opened.callId, channel);
    this.#ctx.set(opened.callId, {
      from: opts.from,
      peer: null,
      topic: opts.topic,
      startedAt: new Date().toISOString(),
      transcript: [],
      summary: null,
    });
    return { code, callId: opened.callId, channel };
  }

  /**
   * Join an existing call using a code shared out-of-band. Derives the same
   * per-call channel from the code and registers it for the returned callId.
   */
  async join(opts: {
    from: Extension;
    code: string;
  }): Promise<{ callId: string; peer: Extension; channel: PairingChannel }> {
    const channel = channelFromCode(opts.code);
    const send: ClientToRelay = {
      t: 'join',
      rendezvousId: rendezvousId(opts.code),
      from: opts.from,
    };
    const joined = await this.#request<JoinedFrame>(this.#pendingJoin, channel, send);
    this.#channels.set(joined.callId, channel);
    this.#ctx.set(joined.callId, {
      from: opts.from,
      peer: joined.peer,
      topic: '(joined)',
      startedAt: new Date().toISOString(),
      transcript: [],
      summary: null,
    });
    // `peer` is the opener's extension, reported by the relay in the `joined`
    // frame. Surfacing it lets callers address outbound messages correctly.
    return { callId: joined.callId, peer: joined.peer, channel };
  }

  /**
   * Seal a Message with the call's channel and ship the ciphertext to the relay.
   * The relay routes it to the other endpoint; it never sees the plaintext.
   */
  async send(callId: string, msg: Message): Promise<void> {
    const channel = this.#channels.get(callId);
    if (!channel) throw new Error(`no channel for call ${callId}`);

    // Defense in depth: validate our own outbound message and cap content.
    if (Buffer.byteLength(msg.content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new Error(`content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    parseMessage(msg);

    const plaintext = Buffer.from(JSON.stringify(msg), 'utf8');
    const sealed = channel.seal(plaintext);
    const frame = Buffer.from(sealed).toString('base64');

    this.#sendFrame({ t: 'send', callId, frame });
    this.#record(callId, msg);
  }

  /**
   * Declare the call resolved with a human/agent-readable `summary`, then end
   * it. Sends a `resolve` message (the peer learns the conclusion) and hangs up.
   * The summary lands in both sides' end-of-call report.
   */
  async resolve(callId: string, summary: string): Promise<void> {
    const ctx = this.#ctx.get(callId);
    if (!ctx) throw new Error(`no such call ${callId}`);
    if (!ctx.peer) throw new Error('cannot resolve before a peer has joined');
    ctx.summary = summary;
    const msg: Message = {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId,
      from: ctx.from,
      to: ctx.peer,
      type: 'resolve',
      ts: new Date().toISOString(),
      turn: ctx.transcript.length,
      inReplyTo: null,
      content: summary,
    };
    await this.send(callId, msg);
    await this.hangup(callId);
  }

  /** Build the end-of-call report from the recorded transcript. */
  buildReport(callId: string, outcome: CallOutcome): CallReport | null {
    const ctx = this.#ctx.get(callId);
    if (!ctx) return null;
    return {
      callId,
      topic: ctx.topic,
      me: ctx.from,
      peer: ctx.peer,
      outcome,
      summary: outcome === 'resolved' ? ctx.summary : null,
      turns: ctx.transcript.length,
      startedAt: ctx.startedAt,
      endedAt: new Date().toISOString(),
      transcript: ctx.transcript,
    };
  }

  #record(callId: string, msg: Message): void {
    const ctx = this.#ctx.get(callId);
    if (!ctx) return;
    const entry: TranscriptEntry = {
      from: msg.from,
      type: msg.type,
      content: msg.content,
      ts: msg.ts,
    };
    ctx.transcript.push(entry);
  }

  /** Register a callback for decrypted, validated inbound messages. */
  onMessage(cb: MessageCb): void {
    this.#messageCbs.push(cb);
  }

  /** Register a callback for remote hangups. */
  onHangup(cb: HangupCb): void {
    this.#hangupCbs.push(cb);
  }

  /**
   * Register a callback fired when the OPENER's peer joins the call. The opener
   * learns the joiner's extension here (the relay reports it in `peer-joined`),
   * which a session layer needs to address outbound messages before the peer
   * has sent anything.
   */
  onPeerJoined(cb: PeerJoinedCb): void {
    this.#peerJoinedCbs.push(cb);
  }

  /** Register a callback fired when the PEER declares the call resolved. */
  onResolved(cb: ResolvedCb): void {
    this.#resolvedCbs.push(cb);
  }

  /** Tear down a single call and tell the relay. */
  async hangup(callId: string): Promise<void> {
    this.#sendFrame({ t: 'hangup', callId });
    this.#channels.delete(callId);
  }

  /** Close the underlying WebSocket and drop all per-call state. */
  close(): void {
    this.#closed = true;
    this.#channels.clear();
    try {
      this.#ws.close();
    } catch {
      // already closing/closed
    }
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Send a control frame, attach the channel/pending bookkeeping, and return a
   * promise that resolves when the matching relay reply arrives.
   */
  #request<T extends OpenedFrame | JoinedFrame>(
    queue: Pending<T>[],
    channel: PairingChannel,
    frame: ClientToRelay,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ resolve, reject });
      this.#pendingChannel.push(channel);
      try {
        this.#sendFrame(frame);
      } catch (err) {
        queue.pop();
        this.#pendingChannel.pop();
        reject(err as Error);
      }
    });
  }

  #sendFrame(frame: ClientToRelay): void {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('switchboard client is not connected');
    }
    this.#ws.send(JSON.stringify(frame));
  }

  #onWireData(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      process.stderr.write('[switchboard] dropped non-JSON relay frame\n');
      return;
    }
    const frame = parseRelayFrame(parsed);
    if (!frame) {
      process.stderr.write('[switchboard] dropped malformed relay frame\n');
      return;
    }

    switch (frame.t) {
      case 'opened': {
        const pending = this.#pendingOpen.shift();
        const channel = this.#pendingChannel.shift();
        // Register the channel SYNCHRONOUSLY here, not in the awaited start()
        // continuation: ws can emit `opened` and a following `deliver` in the
        // same synchronous batch, and a message sent the instant we pair would
        // otherwise hit an unregistered channel and be dropped.
        if (channel) this.#channels.set(frame.callId, channel);
        if (pending) pending.resolve(frame);
        return;
      }
      case 'joined': {
        const pending = this.#pendingJoin.shift();
        const channel = this.#pendingChannel.shift();
        if (channel) this.#channels.set(frame.callId, channel);
        if (pending) pending.resolve(frame);
        return;
      }
      case 'peer-joined': {
        // The opener learns its peer connected, and who they are. Channel was
        // already registered at start; surface the peer to any session layer.
        const ctx = this.#ctx.get(frame.callId);
        if (ctx) ctx.peer = frame.peer;
        for (const cb of this.#peerJoinedCbs) cb(frame.callId, frame.peer);
        return;
      }
      case 'deliver': {
        this.#onDeliver(frame.callId, frame.frame);
        return;
      }
      case 'hangup': {
        this.#channels.delete(frame.callId);
        for (const cb of this.#hangupCbs) cb(frame.reason);
        return;
      }
      case 'error': {
        this.#onError(frame);
        return;
      }
    }
  }

  /** Decrypt, validate (defense in depth), and dispatch one delivered frame. */
  #onDeliver(callId: string, b64: string): void {
    const channel = this.#channels.get(callId);
    if (!channel) {
      process.stderr.write(`[switchboard] deliver for unknown call ${callId}; dropped\n`);
      return;
    }
    let msg: Message;
    try {
      const ciphertext = Buffer.from(b64, 'base64');
      const plaintext = channel.open(ciphertext); // throws on tamper
      const json: unknown = JSON.parse(Buffer.from(plaintext).toString('utf8'));
      msg = parseMessage(json); // throws on schema violation
    } catch (err) {
      process.stderr.write(
        `[switchboard] dropped undecryptable/invalid frame on ${callId}: ${String(err)}\n`,
      );
      return;
    }
    this.#record(callId, msg);

    // A `resolve` message is the peer concluding the call with a summary — it
    // is not a normal query, so surface it via onResolved, not onMessage.
    if (msg.type === 'resolve') {
      const ctx = this.#ctx.get(callId);
      if (ctx) ctx.summary = msg.content;
      for (const cb of this.#resolvedCbs) cb(callId, msg.content);
      return;
    }

    for (const cb of this.#messageCbs) cb(msg);
  }

  /**
   * Relay reported a violation. Reject the oldest in-flight request if any,
   * otherwise log — an error can also be unsolicited (e.g. turn cap on send).
   */
  #onError(frame: ErrorFrame): void {
    const err = new Error(`relay error [${frame.code}]: ${frame.message}`);
    const pendingJoin = this.#pendingJoin.shift();
    if (pendingJoin) {
      this.#pendingChannel.shift();
      pendingJoin.reject(err);
      return;
    }
    const pendingOpen = this.#pendingOpen.shift();
    if (pendingOpen) {
      this.#pendingChannel.shift();
      pendingOpen.reject(err);
      return;
    }
    process.stderr.write(`[switchboard] ${err.message}\n`);
  }

  #onClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    const err = new Error(`switchboard disconnected: ${reason}`);
    for (const p of this.#pendingOpen.splice(0)) p.reject(err);
    for (const p of this.#pendingJoin.splice(0)) p.reject(err);
    this.#pendingChannel.splice(0);
    this.#channels.clear();
  }
}
