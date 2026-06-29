//! The Switchboard relay (Rust). Mirrors `packages/relay/src/server.ts`.
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use frames::*;
use registry::*;

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);
const REAP_INTERVAL: Duration = Duration::from_secs(60);

/// Shared relay state. One std Mutex guards both the registry and the live
/// connection senders; all handlers are synchronous (unbounded `send` never
/// awaits), so the lock is never held across an `.await`.
struct State {
    reg: CallRegistry,
    conns: HashMap<Endpoint, UnboundedSender<Message>>,
}

impl State {
    fn new() -> Self {
        State { reg: CallRegistry::new(PAIRING_TTL, CALL_IDLE_TTL), conns: HashMap::new() }
    }
    /// Queue a server frame to an endpoint, if it is still connected.
    fn send(&self, ep: Endpoint, frame: ServerFrame) {
        if let Some(tx) = self.conns.get(&ep) {
            let _ = tx.send(Message::Text(frame.to_json()));
        }
    }
    fn connected(&self, ep: Endpoint) -> bool {
        self.conns.contains_key(&ep)
    }
}

type Shared = Arc<Mutex<State>>;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("SWITCHBOARD_RELAY_PORT")
        .ok()
        .or_else(|| std::env::args().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787);
    let host = std::env::var("SWITCHBOARD_RELAY_HOST").unwrap_or_else(|_| "0.0.0.0".into());

    let listener = match TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[switchboard-relay] failed to bind {host}:{port}: {e}");
            std::process::exit(1);
        }
    };
    let bound = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();
    eprintln!("[switchboard-relay] listening on ws://{bound}");

    let state: Shared = Arc::new(Mutex::new(State::new()));
    tokio::spawn(reaper(state.clone()));

    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let state = state.clone();
                tokio::spawn(handle_conn(tcp, state));
            }
            Err(e) => eprintln!("[switchboard-relay] accept error: {e}"),
        }
    }
}

async fn handle_conn(tcp: tokio::net::TcpStream, state: Shared) {
    let ws = match accept_async(tcp).await {
        Ok(ws) => ws,
        Err(_) => return, // not a valid websocket handshake
    };
    let (mut write, mut read) = ws.split();
    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);

    let (tx, mut rx) = unbounded_channel::<Message>();
    state.lock().unwrap().conns.insert(conn_id, tx);

    // Writer task: drain queued frames to the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = read.next().await {
        match msg {
            Message::Text(t) => handle_frame(&state, conn_id, &t),
            Message::Binary(b) => match String::from_utf8(b) {
                Ok(t) => handle_frame(&state, conn_id, &t),
                Err(_) => {
                    state
                        .lock()
                        .unwrap()
                        .send(conn_id, ServerFrame::error("BAD_FRAME", "control frame is not valid UTF-8"));
                }
            },
            Message::Close(_) => break,
            _ => {} // ping/pong/frame: ignore
        }
    }

    handle_disconnect(&state, conn_id);
    writer.abort();
}

/// Parse and route one client control frame.
fn handle_frame(state: &Shared, conn: Endpoint, text: &str) {
    let mut st = state.lock().unwrap();

    let frame: ClientFrame = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(_) => {
            st.send(conn, ServerFrame::error("BAD_FRAME", "control frame is not valid JSON"));
            return;
        }
    };

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
    let mut st = state.lock().unwrap();
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
        let mut st = state.lock().unwrap();
        let reaped = st.reg.reap();
        for call in reaped {
            for ep in call.endpoints {
                st.send(ep, ServerFrame::Hangup { call_id: call.call_id.clone(), reason: "call reaped (idle timeout)".into() });
            }
        }
    }
}
