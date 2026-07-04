import {
  newCallId,
  PAIRING_TTL_MS,
  CALL_IDLE_TTL_MS,
  DEFAULT_MAX_TURNS,
  ABSOLUTE_MAX_TURNS,
  type CallState,
} from '@magpie/protocol';

/**
 * In-memory magpie state. MVP storage; swap for a shared/durable store
 * (Redis/SQLite) without changing the {@link RelayServer} surface.
 *
 * The registry is intentionally transport-agnostic: it knows nothing about
 * WebSockets. An "endpoint" is just an opaque marker (`E`) the caller supplies
 * — the relay layer binds it to a socket. This keeps the core unit-testable and
 * keeps routing decisions (who is the "other" endpoint) honest.
 *
 * It also never touches the filesystem and never interpolates `from`/`callId`
 * into any path: callIds are minted by the relay, rendezvous ids are opaque
 * hex, and nothing here is keyed by a filesystem path.
 */

/** A rendezvous awaiting its second participant. */
export interface Pending<E> {
  readonly rendezvousId: string;
  readonly callId: string;
  /** Extension address of the opener. */
  readonly from: string;
  readonly topic: string;
  readonly maxTurns: number;
  /** The opener's endpoint, so we can push `peer-joined` to them. */
  readonly opener: E;
  readonly createdAt: number;
}

/** A live, paired call between exactly two endpoints. */
export interface LiveCall<E> {
  readonly callId: string;
  readonly topic: string;
  /** [opener, joiner] extension addresses. */
  readonly participants: readonly [string, string];
  /** [opener, joiner] endpoints. */
  endpoints: [E, E];
  state: CallState;
  /** Turns consumed so far (incremented per delivered 'query'). */
  turn: number;
  readonly maxTurns: number;
  readonly createdAt: number;
  updatedAt: number;
}

/** Clamp a caller-requested turn cap into `[1, ABSOLUTE_MAX_TURNS]`. */
export function clampMaxTurns(requested: number | undefined): number {
  const n = requested ?? DEFAULT_MAX_TURNS;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.trunc(n), ABSOLUTE_MAX_TURNS);
}

export interface RegistryOptions {
  pairingTtlMs?: number;
  callIdleTtlMs?: number;
  /** Override the clock — handy for deterministic tests. */
  now?: () => number;
}

export class CallRegistry<E> {
  readonly #pending = new Map<string, Pending<E>>(); // keyed by rendezvousId
  readonly #calls = new Map<string, LiveCall<E>>(); // keyed by callId
  readonly #pairingTtlMs: number;
  readonly #callIdleTtlMs: number;
  readonly #now: () => number;

  constructor(opts: RegistryOptions = {}) {
    this.#pairingTtlMs = opts.pairingTtlMs ?? PAIRING_TTL_MS;
    this.#callIdleTtlMs = opts.callIdleTtlMs ?? CALL_IDLE_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Register an opener at a rendezvous. Returns the freshly minted callId.
   * Throws `ALREADY_PAIRED` if a live or pending rendezvous already exists.
   */
  open(args: {
    rendezvousId: string;
    from: string;
    topic: string;
    maxTurns: number;
    opener: E;
  }): Pending<E> {
    this.#expirePending();
    if (this.#pending.has(args.rendezvousId)) {
      throw new RegistryError('ALREADY_PAIRED', 'rendezvous already has a pending opener');
    }
    const pending: Pending<E> = {
      rendezvousId: args.rendezvousId,
      callId: newCallId(),
      from: args.from,
      topic: args.topic,
      maxTurns: args.maxTurns,
      opener: args.opener,
      createdAt: this.#now(),
    };
    this.#pending.set(args.rendezvousId, pending);
    return pending;
  }

  /**
   * Second participant consumes the rendezvous, promoting it to a live call.
   * Throws `UNKNOWN_RENDEZVOUS` / `EXPIRED` as appropriate.
   */
  join(args: { rendezvousId: string; from: string; joiner: E }): LiveCall<E> {
    this.#expirePending();
    const pending = this.#pending.get(args.rendezvousId);
    if (!pending) {
      throw new RegistryError('UNKNOWN_RENDEZVOUS', 'no such rendezvous (unknown, expired, or already paired)');
    }
    if (this.#now() - pending.createdAt > this.#pairingTtlMs) {
      this.#pending.delete(args.rendezvousId);
      throw new RegistryError('EXPIRED', 'pairing code expired');
    }
    // Single-use: consume the rendezvous so no third party can join.
    this.#pending.delete(args.rendezvousId);
    const t = this.#now();
    const call: LiveCall<E> = {
      callId: pending.callId,
      topic: pending.topic,
      participants: [pending.from, args.from],
      endpoints: [pending.opener, args.joiner],
      state: 'open',
      turn: 0,
      maxTurns: pending.maxTurns,
      createdAt: t,
      updatedAt: t,
    };
    this.#calls.set(call.callId, call);
    return call;
  }

  getPending(rendezvousId: string): Pending<E> | undefined {
    return this.#pending.get(rendezvousId);
  }

  getCall(callId: string): LiveCall<E> | undefined {
    return this.#calls.get(callId);
  }

  /** Index of the endpoint within a call, or -1 if it is not a participant. */
  endpointIndex(call: LiveCall<E>, endpoint: E): 0 | 1 | -1 {
    if (call.endpoints[0] === endpoint) return 0;
    if (call.endpoints[1] === endpoint) return 1;
    return -1;
  }

  /** The other endpoint in a call relative to `self`. */
  peerEndpoint(call: LiveCall<E>, self: E): E | undefined {
    const i = this.endpointIndex(call, self);
    if (i === -1) return undefined;
    return call.endpoints[i === 0 ? 1 : 0];
  }

  /** Mark activity so the idle reaper leaves the call alone. */
  touch(call: LiveCall<E>): void {
    call.updatedAt = this.#now();
  }

  /**
   * Account for a delivered 'query'. Increments the turn counter and enforces
   * the cap. Throws `TURN_CAP` (and closes the call) once the cap is reached.
   * Non-query messages MUST NOT call this — they don't consume turns.
   */
  consumeQueryTurn(call: LiveCall<E>): void {
    if (call.turn >= call.maxTurns) {
      call.state = 'closed';
      throw new RegistryError('TURN_CAP', `turn cap of ${call.maxTurns} reached`);
    }
    call.turn += 1;
    call.state = 'answered';
    this.touch(call);
  }

  /** Close + remove a call. Returns the removed call (for routing a hangup). */
  close(callId: string): LiveCall<E> | undefined {
    const call = this.#calls.get(callId);
    if (!call) return undefined;
    call.state = 'closed';
    this.#calls.delete(callId);
    return call;
  }

  /** Drop every pending/live state owned by an endpoint (on disconnect). */
  dropEndpoint(endpoint: E): { closed: LiveCall<E>[] } {
    const closed: LiveCall<E>[] = [];
    for (const [rid, p] of this.#pending) {
      if (p.opener === endpoint) this.#pending.delete(rid);
    }
    for (const [id, call] of this.#calls) {
      if (this.endpointIndex(call, endpoint) !== -1) {
        call.state = 'closed';
        this.#calls.delete(id);
        closed.push(call);
      }
    }
    return { closed };
  }

  /** Reap idle calls and expired pendings. Returns calls that were reaped. */
  reap(): { reaped: LiveCall<E>[] } {
    this.#expirePending();
    const reaped: LiveCall<E>[] = [];
    const t = this.#now();
    for (const [id, call] of this.#calls) {
      if (t - call.updatedAt > this.#callIdleTtlMs) {
        call.state = 'closed';
        this.#calls.delete(id);
        reaped.push(call);
      }
    }
    return { reaped };
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
  get callCount(): number {
    return this.#calls.size;
  }

  #expirePending(): void {
    const t = this.#now();
    for (const [rid, p] of this.#pending) {
      if (t - p.createdAt > this.#pairingTtlMs) this.#pending.delete(rid);
    }
  }
}

/** Typed error carrying a wire {@link import('./wire.js').ErrorCode}. */
export class RegistryError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_RENDEZVOUS'
      | 'EXPIRED'
      | 'ALREADY_PAIRED'
      | 'TURN_CAP'
      | 'UNKNOWN_CALL'
      | 'NOT_PARTICIPANT'
      | 'CALL_CLOSED'
      | 'PEER_GONE',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}
