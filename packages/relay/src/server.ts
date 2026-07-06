import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  PAIRING_TTL_MS,
  CALL_IDLE_TTL_MS,
} from '@magpie/protocol';
import { CallRegistry, clampMaxTurns, RegistryError } from './store.js';
import type { LiveCall } from './store.js';
import { ClientFrame } from './wire.js';
import type { ServerFrame, ErrorCode } from './wire.js';

/**
 * The magpie relay.
 *
 * It speaks the RELAY<->CLIENT control protocol (see {@link ClientFrame}) over
 * WebSocket. Its entire job is to PAIR two endpoints at a rendezvous and then
 * ROUTE opaque sealed frames between them, enforcing the turn cap and reaping
 * idle calls. It brokers CIPHERTEXT ONLY: it never unseals, never inspects the
 * payload, and never touches the filesystem.
 *
 * Each WebSocket connection is one endpoint. The registry is keyed by the
 * `WebSocket` object identity, so routing the "other endpoint" is exact and
 * cannot be spoofed by a client claiming a different address.
 */
export interface RelayOptions {
  port?: number;
  host?: string;
  pairingTtlMs?: number;
  callIdleTtlMs?: number;
  /** How often to run the idle-call reaper. */
  reapIntervalMs?: number;
}

export interface RelayHandle {
  /** The actual bound port (useful when port 0 was requested). */
  readonly port: number;
  readonly wss: WebSocketServer;
  close(): Promise<void>;
}

const DEFAULT_REAP_INTERVAL_MS = 60_000;

export class RelayServer {
  readonly wss: WebSocketServer;
  readonly #registry: CallRegistry<WebSocket>;
  readonly #reaper: NodeJS.Timeout;

  constructor(wss: WebSocketServer, opts: RelayOptions = {}) {
    this.wss = wss;
    this.#registry = new CallRegistry<WebSocket>({
      pairingTtlMs: opts.pairingTtlMs ?? PAIRING_TTL_MS,
      callIdleTtlMs: opts.callIdleTtlMs ?? CALL_IDLE_TTL_MS,
    });

    this.wss.on('connection', (ws) => this.#onConnection(ws));

    const interval = opts.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.#reaper = setInterval(() => this.#reap(), interval);
    // Don't keep the event loop alive solely for reaping.
    this.#reaper.unref?.();
  }

  #onConnection(ws: WebSocket): void {
    ws.on('message', (data) => this.#onMessage(ws, data));
    ws.on('close', () => this.#onClose(ws));
    // Swallow socket errors — a dead socket is handled by 'close'.
    ws.on('error', () => {});
  }

  #onMessage(ws: WebSocket, data: unknown): void {
    let json: unknown;
    try {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : Buffer.from(data as ArrayBuffer).toString('utf8');
      json = JSON.parse(text);
    } catch {
      this.#sendError(ws, 'BAD_FRAME', 'control frame is not valid JSON');
      return;
    }

    const parsed = ClientFrame.safeParse(json);
    if (!parsed.success) {
      this.#sendError(ws, 'BAD_FRAME', `invalid control frame: ${parsed.error.issues[0]?.message ?? 'schema violation'}`);
      return;
    }

    const frame = parsed.data;
    try {
      switch (frame.t) {
        case 'open':
          this.#handleOpen(ws, frame);
          break;
        case 'join':
          this.#handleJoin(ws, frame);
          break;
        case 'send':
          this.#handleSend(ws, frame);
          break;
        case 'hangup':
          this.#handleHangup(ws, frame);
          break;
      }
    } catch (err) {
      if (err instanceof RegistryError) {
        this.#sendError(ws, err.code as ErrorCode, err.message);
      } else {
        this.#sendError(ws, 'BAD_FRAME', 'internal routing error');
      }
    }
  }

  #handleOpen(ws: WebSocket, frame: Extract<ClientFrame, { t: 'open' }>): void {
    const pending = this.#registry.open({
      rendezvousId: frame.rendezvousId,
      from: frame.from,
      topic: frame.topic,
      maxTurns: clampMaxTurns(frame.maxTurns),
      opener: ws,
    });
    this.#send(ws, { t: 'opened', callId: pending.callId });
  }

  #handleJoin(ws: WebSocket, frame: Extract<ClientFrame, { t: 'join' }>): void {
    const call = this.#registry.join({
      rendezvousId: frame.rendezvousId,
      from: frame.from,
      joiner: ws,
    });
    // Tell the joiner who they reached, and notify the opener that they joined.
    this.#send(ws, { t: 'joined', callId: call.callId, peer: call.participants[0] });
    this.#send(call.endpoints[0], {
      t: 'peer-joined',
      callId: call.callId,
      peer: call.participants[1],
    });
  }

  #handleSend(ws: WebSocket, frame: Extract<ClientFrame, { t: 'send' }>): void {
    const call = this.#registry.getCall(frame.callId);
    if (!call) throw new RegistryError('UNKNOWN_CALL', 'no such call');
    if (call.state === 'closed') throw new RegistryError('CALL_CLOSED', 'call is closed');
    const idx = this.#registry.endpointIndex(call, ws);
    if (idx === -1) throw new RegistryError('NOT_PARTICIPANT', 'sender is not a participant in this call');

    const peer = this.#registry.peerEndpoint(call, ws);
    if (!peer || peer.readyState !== WebSocket.OPEN) {
      throw new RegistryError('PEER_GONE', 'the other endpoint is no longer connected');
    }

    // Turn accounting BEFORE delivery so a cap violation never reaches the peer.
    // The relay cannot read the sealed payload, so it counts every delivered
    // `send` as one turn — the strongest cap it can enforce without unsealing.
    // On cap, close the call and notify BOTH ends with a clean hangup so each
    // side stops and escalates to its human, rather than the sender getting a
    // bare error and the peer being left hanging.
    try {
      this.#registry.consumeQueryTurn(call);
    } catch (err) {
      if (err instanceof RegistryError && err.code === 'TURN_CAP') {
        const reason = `turn cap of ${call.maxTurns} reached`;
        const ends = [...call.endpoints];
        this.#registry.close(call.callId);
        for (const ep of ends) this.#send(ep, { t: 'hangup', callId: call.callId, reason });
        return;
      }
      throw err;
    }

    this.#send(peer, { t: 'deliver', callId: call.callId, frame: frame.frame });
  }

  #handleHangup(ws: WebSocket, frame: Extract<ClientFrame, { t: 'hangup' }>): void {
    const call = this.#registry.getCall(frame.callId);
    if (!call) throw new RegistryError('UNKNOWN_CALL', 'no such call');
    const idx = this.#registry.endpointIndex(call, ws);
    if (idx === -1) throw new RegistryError('NOT_PARTICIPANT', 'sender is not a participant in this call');

    const peer = this.#registry.peerEndpoint(call, ws);
    const reason = frame.reason ?? 'peer hung up';
    this.#registry.close(frame.callId);
    if (peer && peer.readyState === WebSocket.OPEN) {
      this.#send(peer, { t: 'hangup', callId: frame.callId, reason });
    }
  }

  #onClose(ws: WebSocket): void {
    const { closed } = this.#registry.dropEndpoint(ws);
    for (const call of closed) {
      const peer = this.#peerOf(call, ws);
      if (peer && peer.readyState === WebSocket.OPEN) {
        this.#send(peer, { t: 'hangup', callId: call.callId, reason: 'peer disconnected' });
      }
    }
  }

  #peerOf(call: LiveCall<WebSocket>, self: WebSocket): WebSocket | undefined {
    if (call.endpoints[0] === self) return call.endpoints[1];
    if (call.endpoints[1] === self) return call.endpoints[0];
    return undefined;
  }

  #reap(): void {
    const { reaped } = this.#registry.reap();
    for (const call of reaped) {
      for (const ep of call.endpoints) {
        if (ep.readyState === WebSocket.OPEN) {
          this.#send(ep, { t: 'hangup', callId: call.callId, reason: 'call reaped (idle timeout)' });
        }
      }
    }
  }

  #send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  #sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.#send(ws, { t: 'error', code, message });
  }

  /** Stop the reaper. Does not close the underlying server (caller owns it). */
  dispose(): void {
    clearInterval(this.#reaper);
  }
}

/**
 * Start a relay on `port` (0 = ephemeral). Resolves once it is listening.
 *
 * @example
 * const relay = await startRelay(8787);
 * // ... later
 * await relay.close();
 */
export function startRelay(port = 0, opts: RelayOptions = {}): Promise<RelayHandle> {
  return new Promise((resolve, reject) => {
    const host = opts.host ?? '0.0.0.0';
    // 2 MiB bounds every legal control frame (MAX_SEALED_FRAME + envelope);
    // the ws default (100 MiB) lets one client force huge buffer allocations.
    const wss = new WebSocketServer({ port, host, maxPayload: 2 * 1024 * 1024 });
    const relay = new RelayServer(wss, opts);

    const onError = (err: Error) => {
      relay.dispose();
      reject(err);
    };
    wss.once('error', onError);
    wss.once('listening', () => {
      wss.off('error', onError);
      const addr = wss.address() as AddressInfo;
      resolve({
        port: addr.port,
        wss,
        close: () =>
          new Promise<void>((res) => {
            relay.dispose();
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}
