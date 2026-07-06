//! The Magpie relay (Rust). Mirrors `packages/relay/src/server.ts`.
//!
//! Speaks the RELAY<->CLIENT control protocol (see `frames`) over WebSocket. Its
//! entire job is to PAIR two endpoints at a rendezvous and ROUTE opaque sealed
//! frames between them, enforcing the turn cap and reaping idle calls. It brokers
//! CIPHERTEXT ONLY: never unseals, never inspects the payload, never touches the
//! filesystem. Each WebSocket connection is one endpoint; the registry is keyed
//! by an opaque connection id, so routing the "other endpoint" cannot be spoofed.

mod frames;
mod registry;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{channel, error::TrySendError, Sender};
use tokio_tungstenite::accept_async_with_config;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use frames::*;
use registry::*;

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);
const REAP_INTERVAL: Duration = Duration::from_secs(60);

// Connection-level abuse caps (slow-loris / flood / OOM):
/// A client that hasn't completed the WS handshake in this window is dropped.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Total concurrent connections the relay will hold.
const MAX_CONNS: usize = 4096;
/// Concurrent connections from one source IP.
const MAX_CONNS_PER_IP: usize = 64;
/// Outbound frames queued per connection. Honest clients drain their socket;
/// a peer that stops reading gets evicted instead of buffering unbounded.
const OUTBOUND_QUEUE: usize = 256;
/// Per-connection inbound rate limit (token bucket): steady rate and burst.
/// Honest traffic is ~1 frame per LLM turn (~30 s); 30/s is orders above that.
const RATE_PER_SEC: f64 = 30.0;
const RATE_BURST: f64 = 60.0;

/// Shared relay state. One std Mutex guards both the registry and the live
/// connection senders; all handlers are synchronous (`try_send` never awaits),
/// so the lock is never held across an `.await`.
struct State {
    reg: CallRegistry,
    conns: HashMap<Endpoint, Sender<Message>>,
    /// Live connections per source IP (per-IP cap accounting).
    ips: HashMap<IpAddr, usize>,
}

impl State {
    fn new() -> Self {
        State {
            reg: CallRegistry::new(PAIRING_TTL, CALL_IDLE_TTL),
            conns: HashMap::new(),
            ips: HashMap::new(),
        }
    }
    /// Queue a server frame to an endpoint, if it is still connected. A full
    /// queue means the endpoint stopped draining its socket — evict it (the
    /// dropped Sender ends its writer task, which closes the socket).
    fn send(&mut self, ep: Endpoint, frame: ServerFrame) {
        if let Some(tx) = self.conns.get(&ep) {
            if let Err(TrySendError::Full(_)) = tx.try_send(Message::Text(frame.to_json())) {
                self.conns.remove(&ep);
            }
        }
    }
    fn connected(&self, ep: Endpoint) -> bool {
        self.conns.contains_key(&ep)
    }
}

type Shared = Arc<Mutex<State>>;

/// Poison-tolerant lock: a panic in one handler must not wedge the relay.
fn lock(state: &Shared) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("MAGPIE_RELAY_PORT")
        .ok()
        .or_else(|| std::env::args().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787);
    let host = std::env::var("MAGPIE_RELAY_HOST").unwrap_or_else(|_| "0.0.0.0".into());

    let listener = match TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[magpie-relay] failed to bind {host}:{port}: {e}");
            std::process::exit(1);
        }
    };
    let bound = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();
    eprintln!("[magpie-relay] listening on ws://{bound}");

    let state: Shared = Arc::new(Mutex::new(State::new()));
    tokio::spawn(reaper(state.clone()));

    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let state = state.clone();
                tokio::spawn(handle_conn(tcp, state));
            }
            Err(e) => eprintln!("[magpie-relay] accept error: {e}"),
        }
    }
}

/// Simple token bucket, owned by one connection's read loop (no lock needed).
struct RateLimiter {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    fn new() -> Self {
        RateLimiter { tokens: RATE_BURST, last: Instant::now() }
    }
    fn allow(&mut self) -> bool {
        let now = Instant::now();
        self.tokens =
            (self.tokens + now.duration_since(self.last).as_secs_f64() * RATE_PER_SEC).min(RATE_BURST);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

async fn handle_conn(tcp: tokio::net::TcpStream, state: Shared) {
    // Per-IP + global connection caps, reserved BEFORE the handshake so a
    // flood of half-open sockets can't exhaust the relay.
    let ip = match tcp.peer_addr() {
        Ok(addr) => addr.ip(),
        Err(_) => return,
    };
    {
        let mut st = lock(&state);
        let per_ip = st.ips.get(&ip).copied().unwrap_or(0);
        if st.conns.len() >= MAX_CONNS || per_ip >= MAX_CONNS_PER_IP {
            return; // over capacity: drop before spending handshake work
        }
        *st.ips.entry(ip).or_insert(0) += 1;
    }
    let released = ReleaseIp { state: state.clone(), ip };

    let config = WebSocketConfig {
        max_message_size: Some(MAX_WS_MSG),
        max_frame_size: Some(MAX_WS_MSG),
        ..Default::default()
    };
    let ws = match tokio::time::timeout(HANDSHAKE_TIMEOUT, accept_async_with_config(tcp, Some(config)))
        .await
    {
        Ok(Ok(ws)) => ws,
        _ => return, // slow-loris or not a websocket handshake (`released` restores the IP slot)
    };
    let (mut write, mut read) = ws.split();
    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);

    let (tx, mut rx) = channel::<Message>(OUTBOUND_QUEUE);
    lock(&state).conns.insert(conn_id, tx.clone());

    // Writer task: drain queued frames to the socket. When every sender is
    // dropped (disconnect or full-queue eviction), actively close the socket
    // so the read loop below terminates too.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    let mut limiter = RateLimiter::new();
    while let Some(Ok(msg)) = read.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => match String::from_utf8(b) {
                Ok(t) => t,
                Err(_) => {
                    lock(&state).send(
                        conn_id,
                        ServerFrame::error("BAD_FRAME", "control frame is not valid UTF-8"),
                    );
                    continue;
                }
            },
            Message::Close(_) => break,
            _ => continue, // ping/pong/frame: ignore
        };
        if !lock(&state).connected(conn_id) {
            break; // evicted (full outbound queue) — stop reading too
        }
        if !limiter.allow() {
            lock(&state).send(
                conn_id,
                ServerFrame::error("RATE_LIMITED", "too many frames; slow down"),
            );
            continue;
        }
        // Parse + validate OUTSIDE the global lock; only routing takes it.
        match parse_client_frame(&text) {
            Ok(frame) => handle_frame(&state, conn_id, frame),
            Err(why) => lock(&state).send(conn_id, ServerFrame::error("BAD_FRAME", why)),
        }
    }

    handle_disconnect(&state, conn_id);
    writer.abort();
    drop(released);
}

/// Releases one per-IP connection slot on drop, whatever the exit path.
struct ReleaseIp {
    state: Shared,
    ip: IpAddr,
}

impl Drop for ReleaseIp {
    fn drop(&mut self) {
        let mut st = lock(&self.state);
        if let Some(n) = st.ips.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                st.ips.remove(&self.ip);
            }
        }
    }
}

/// Route one validated client control frame.
fn handle_frame(state: &Shared, conn: Endpoint, frame: ClientFrame) {
    let mut st = lock(state);

    match frame {
        ClientFrame::Open { rendezvous_id, from, topic, max_turns } => {
            if !is_rendezvous_id(&rendezvous_id) || !is_extension(&from) || topic.len() > MAX_TOPIC {
                st.send(conn, ServerFrame::error("BAD_FRAME", "invalid open frame"));
                return;
            }
            match st.reg.open(rendezvous_id, from, topic, clamp_max_turns(max_turns), conn) {
                Ok(call_id) => st.send(conn, ServerFrame::Opened { call_id }),
                Err(e) => st.send(conn, ServerFrame::error(e.code(), e.message())),
            }
        }

        ClientFrame::Join { rendezvous_id, from } => {
            if !is_rendezvous_id(&rendezvous_id) || !is_extension(&from) {
                st.send(conn, ServerFrame::error("BAD_FRAME", "invalid join frame"));
                return;
            }
            match st.reg.join(rendezvous_id, from, conn) {
                Ok(call) => {
                    // Tell the joiner who they reached; notify the opener that they joined.
                    st.send(
                        conn,
                        ServerFrame::Joined { call_id: call.call_id.clone(), peer: call.participants[0].clone() },
                    );
                    st.send(
                        call.endpoints[0],
                        ServerFrame::PeerJoined { call_id: call.call_id.clone(), peer: call.participants[1].clone() },
                    );
                }
                Err(e) => st.send(conn, ServerFrame::error(e.code(), e.message())),
            }
        }

        ClientFrame::Send { call_id, frame } => {
            if !is_call_id(&call_id) || !is_sealed_frame(&frame) {
                st.send(conn, ServerFrame::error("BAD_FRAME", "invalid send frame"));
                return;
            }
            // Gather routing facts, then drop the immutable borrow before mutating.
            let (endpoints, closed, max_turns) = match st.reg.get_call(&call_id) {
                Some(c) => (c.endpoints, c.state == CallState::Closed, c.max_turns),
                None => {
                    st.send(conn, ServerFrame::error("UNKNOWN_CALL", "no such call"));
                    return;
                }
            };
            if closed {
                st.send(conn, ServerFrame::error("CALL_CLOSED", "call is closed"));
                return;
            }
            let Some(i) = endpoints.iter().position(|&e| e == conn) else {
                st.send(conn, ServerFrame::error("NOT_PARTICIPANT", "sender is not a participant in this call"));
                return;
            };
            let peer = endpoints[1 - i];
            if !st.connected(peer) {
                st.send(conn, ServerFrame::error("PEER_GONE", "the other endpoint is no longer connected"));
                return;
            }

            // Turn accounting BEFORE delivery: a cap violation never reaches the
            // peer. On cap, close the call and hang up BOTH ends cleanly so each
            // side stops and escalates to its human.
            match st.reg.consume_query_turn(&call_id) {
                Ok(()) => st.send(peer, ServerFrame::Deliver { call_id, frame }),
                Err(RegError::TurnCap) => {
                    let reason = format!("turn cap of {max_turns} reached");
                    st.reg.close(&call_id);
                    for ep in endpoints {
                        st.send(ep, ServerFrame::Hangup { call_id: call_id.clone(), reason: reason.clone() });
                    }
                }
                Err(e) => st.send(conn, ServerFrame::error(e.code(), e.message())),
            }
        }

        ClientFrame::Hangup { call_id, reason } => {
            if !is_call_id(&call_id) || reason.as_deref().map_or(false, |r| r.len() > MAX_REASON) {
                st.send(conn, ServerFrame::error("BAD_FRAME", "invalid hangup frame"));
                return;
            }
            let endpoints = match st.reg.get_call(&call_id) {
                Some(c) => c.endpoints,
                None => {
                    st.send(conn, ServerFrame::error("UNKNOWN_CALL", "no such call"));
                    return;
                }
            };
            let Some(i) = endpoints.iter().position(|&e| e == conn) else {
                st.send(conn, ServerFrame::error("NOT_PARTICIPANT", "sender is not a participant in this call"));
                return;
            };
            let peer = endpoints[1 - i];
            let reason = reason.unwrap_or_else(|| "peer hung up".into());
            st.reg.close(&call_id);
            if st.connected(peer) {
                st.send(peer, ServerFrame::Hangup { call_id, reason });
            }
        }
    }
}

/// On socket close: drop the endpoint's pending/live state and notify peers.
fn handle_disconnect(state: &Shared, conn: Endpoint) {
    let mut st = lock(state);
    st.conns.remove(&conn);
    let closed = st.reg.drop_endpoint(conn);
    for call in closed {
        let peer = if call.endpoints[0] == conn { call.endpoints[1] } else { call.endpoints[0] };
        if st.connected(peer) {
            st.send(peer, ServerFrame::Hangup { call_id: call.call_id, reason: "peer disconnected".into() });
        }
    }
}

/// Periodically reap idle calls and expired pendings, hanging up both ends.
async fn reaper(state: Shared) {
    let mut interval = tokio::time::interval(REAP_INTERVAL);
    interval.tick().await; // consume the immediate first tick
    loop {
        interval.tick().await;
        let mut st = lock(&state);
        let reaped = st.reg.reap();
        for call in reaped {
            for ep in call.endpoints {
                st.send(ep, ServerFrame::Hangup { call_id: call.call_id.clone(), reason: "call reaped (idle timeout)".into() });
            }
        }
    }
}
