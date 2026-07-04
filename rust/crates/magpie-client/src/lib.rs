//! `magpie-client` — a thin async WebSocket client to the relay plus the
//! per-call pairing crypto.
//!
//! Mirror of `packages/client/src/client.ts`. The relay sees CIPHERTEXT ONLY:
//! every `Message` is JSON-serialized, sealed with the call's `PairingChannel`,
//! base64-encoded, and shipped as an opaque `frame`. The channel for a call is
//! held here, keyed by callId, and is the ONLY thing that can read peer payloads.
//!
//! ## Shape vs. the TS reference
//! TS uses event-emitter callbacks and a promise per request. Here:
//! - `connect` spawns a background reader task (decrypt/dispatch) and a writer
//!   task (drain queued control frames to the socket).
//! - `start`/`join` await a `oneshot` correlated FIFO with the relay's reply.
//! - `on_message`/`on_hangup`/`on_peer_joined`/`on_resolved` register `Fn`
//!   callbacks invoked by the reader task.
//!
//! The **join-race fix** is preserved: the per-call channel is registered
//! SYNCHRONOUSLY in the reader the instant `opened`/`joined` arrives — not in the
//! awaited `start`/`join` continuation — so a `deliver` arriving in the same
//! batch as the pairing reply finds a registered channel.

mod wire;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use magpie_protocol::{
    channel_from_code, frame_from_b64, frame_to_b64, generate_pairing_code, new_message_id,
    parse_message, rendezvous_id, ABSOLUTE_MAX_TURNS, DEFAULT_MAX_TURNS, MAX_CONTENT_BYTES,
    PROTOCOL_VERSION,
};
pub use magpie_protocol::{
    CallOutcome, Message, MessageType, PairingChannel, ProtocolError,
};

use wire::{ClientToRelay, RelayToClient};

/// An extension address `@owner/role`. Alias kept for parity with the TS type.
pub type Extension = String;

// ---- public report types (mirror packages/protocol schema.ts) --------------

/// One line of a call transcript (decrypted, from this side's point of view).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub from: Extension,
    #[serde(rename = "type")]
    pub r#type: MessageType,
    pub content: String,
    pub ts: String,
}

/// The artifact handed to a human when a call ends: the outcome, the agent's
/// summary (if it resolved), and the full transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallReport {
    pub call_id: String,
    pub topic: String,
    pub me: Extension,
    pub peer: Option<Extension>,
    pub outcome: CallOutcome,
    /// The resolution summary; present iff `outcome == Resolved`.
    pub summary: Option<String>,
    pub turns: u64,
    pub started_at: String,
    pub ended_at: String,
    pub transcript: Vec<TranscriptEntry>,
}

// ---- errors ----------------------------------------------------------------

/// Failures surfaced to a client caller.
#[derive(Debug)]
pub enum ClientError {
    /// The relay rejected a request (`{ t:"error" }`).
    Relay { code: String, message: String },
    /// A pairing/crypto/schema error from the protocol crate.
    Protocol(ProtocolError),
    /// The socket closed before a reply arrived.
    Disconnected,
    /// The client is closed / not connected.
    NotConnected,
    /// No per-call channel for the given callId (never paired, or torn down).
    NoChannel(String),
    /// No such call in local bookkeeping.
    NoCall(String),
    /// `resolve` attempted before a peer joined.
    NoPeer,
    /// Outbound content exceeds `MAX_CONTENT_BYTES`.
    ContentTooLarge,
    /// WebSocket / transport error.
    Ws(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Relay { code, message } => write!(f, "relay error [{code}]: {message}"),
            ClientError::Protocol(e) => write!(f, "protocol error: {e}"),
            ClientError::Disconnected => write!(f, "magpie disconnected"),
            ClientError::NotConnected => write!(f, "magpie client is not connected"),
            ClientError::NoChannel(c) => write!(f, "no channel for call {c}"),
            ClientError::NoCall(c) => write!(f, "no such call {c}"),
            ClientError::NoPeer => write!(f, "cannot resolve before a peer has joined"),
            ClientError::ContentTooLarge => {
                write!(f, "content exceeds {MAX_CONTENT_BYTES} bytes")
            }
            ClientError::Ws(e) => write!(f, "websocket error: {e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<ProtocolError> for ClientError {
    fn from(e: ProtocolError) -> Self {
        ClientError::Protocol(e)
    }
}

type Result<T> = std::result::Result<T, ClientError>;

// ---- per-call bookkeeping --------------------------------------------------

/// Per-call transcript + metadata, for building the end-of-call report.
struct CallCtx {
    from: Extension,
    peer: Option<Extension>,
    topic: String,
    started_at: String,
    transcript: Vec<TranscriptEntry>,
    /// Set when a `resolve` message is sent or received.
    summary: Option<String>,
}

/// Reply carried over a pending `open` oneshot: the minted callId.
type OpenReply = Result<String>;
/// Reply carried over a pending `join` oneshot: `(callId, peer)`.
type JoinReply = Result<(String, Extension)>;

#[derive(Default)]
struct ClientState {
    /// Per-call E2E channel. The relay can never produce one of these.
    channels: HashMap<String, Arc<PairingChannel>>,
    ctx: HashMap<String, CallCtx>,
    /// FIFO of in-flight open/join requests (relay correlates by order).
    pending_open: VecDeque<oneshot::Sender<OpenReply>>,
    pending_join: VecDeque<oneshot::Sender<JoinReply>>,
    /// The channel each in-flight open/join is about to be bound to, queued in
    /// the SAME order across both request types (mirrors TS `#pendingChannel`).
    pending_channel: VecDeque<Arc<PairingChannel>>,
    closed: bool,
}

type MessageCb = Arc<dyn Fn(Message) + Send + Sync>;
type HangupCb = Arc<dyn Fn(String) + Send + Sync>;
type PeerJoinedCb = Arc<dyn Fn(String, Extension) + Send + Sync>;
type ResolvedCb = Arc<dyn Fn(String, String) + Send + Sync>;

#[derive(Default)]
struct Callbacks {
    message: Vec<MessageCb>,
    hangup: Vec<HangupCb>,
    peer_joined: Vec<PeerJoinedCb>,
    resolved: Vec<ResolvedCb>,
}

struct Inner {
    out_tx: UnboundedSender<WsMessage>,
    state: Mutex<ClientState>,
    callbacks: Mutex<Callbacks>,
}

/// Returned by `start`: the human-shareable code and the minted callId.
#[derive(Debug, Clone)]
pub struct Started {
    pub code: String,
    pub call_id: String,
}

/// Returned by `join`: the callId and the opener's extension.
#[derive(Debug, Clone)]
pub struct Joined {
    pub call_id: String,
    pub peer: Extension,
}

/// Options for opening a new call.
#[derive(Debug, Clone)]
pub struct StartOpts {
    pub from: Extension,
    pub topic: String,
    pub max_turns: Option<u32>,
}

/// Options for joining an existing call by code.
#[derive(Debug, Clone)]
pub struct JoinOpts {
    pub from: Extension,
    pub code: String,
}

/// A thin async WebSocket client to the relay plus the per-call pairing crypto.
#[derive(Clone)]
pub struct MagpieClient {
    inner: Arc<Inner>,
}

impl MagpieClient {
    /// Open a WebSocket to the relay and resolve once it is ready.
    pub async fn connect(relay_url: &str) -> Result<MagpieClient> {
        let (ws, _resp) = connect_async(relay_url)
            .await
            .map_err(|e| ClientError::Ws(e.to_string()))?;
        let (write, read) = ws.split();

        let (out_tx, out_rx) = unbounded_channel::<WsMessage>();
        let inner = Arc::new(Inner {
            out_tx,
            state: Mutex::new(ClientState::default()),
            callbacks: Mutex::new(Callbacks::default()),
        });

        tokio::spawn(writer_task(write, out_rx));
        tokio::spawn(reader_task(read, inner.clone()));

        Ok(MagpieClient { inner })
    }

    /// Open a new call. Mints a fresh pairing code, derives the per-call channel,
    /// and tells the relay to register the rendezvous. Returns the human code and
    /// the callId; the channel is retained internally.
    pub async fn start(&self, opts: StartOpts) -> Result<Started> {
        let code = generate_pairing_code();
        let channel = Arc::new(channel_from_code(&code)?);

        // Clamp client-side too; the relay re-clamps, but never send nonsense.
        let requested = opts.max_turns.unwrap_or(DEFAULT_MAX_TURNS);
        let max_turns = requested.clamp(1, ABSOLUTE_MAX_TURNS);

        let frame = ClientToRelay::Open {
            rendezvous_id: rendezvous_id(&code)?,
            from: opts.from.clone(),
            topic: opts.topic.clone(),
            max_turns,
        };

        let (tx, rx) = oneshot::channel::<OpenReply>();
        {
            let mut st = self.inner.state.lock().unwrap();
            if st.closed {
                return Err(ClientError::NotConnected);
            }
            st.pending_open.push_back(tx);
            st.pending_channel.push_back(channel.clone());
        }
        if let Err(e) = self.send_frame(&frame) {
            let mut st = self.inner.state.lock().unwrap();
            st.pending_open.pop_back();
            st.pending_channel.pop_back();
            return Err(e);
        }

        let call_id = rx.await.map_err(|_| ClientError::Disconnected)??;
        {
            let mut st = self.inner.state.lock().unwrap();
            st.channels.insert(call_id.clone(), channel);
            st.ctx.insert(
                call_id.clone(),
                CallCtx {
                    from: opts.from,
                    peer: None,
                    topic: opts.topic,
                    started_at: now_iso(),
                    transcript: Vec::new(),
                    summary: None,
                },
            );
        }
        Ok(Started { code, call_id })
    }

    /// Join an existing call using a code shared out-of-band. Derives the same
    /// per-call channel from the code and registers it for the returned callId.
    pub async fn join(&self, opts: JoinOpts) -> Result<Joined> {
        let channel = Arc::new(channel_from_code(&opts.code)?);
        let frame = ClientToRelay::Join {
            rendezvous_id: rendezvous_id(&opts.code)?,
            from: opts.from.clone(),
        };

        let (tx, rx) = oneshot::channel::<JoinReply>();
        {
            let mut st = self.inner.state.lock().unwrap();
            if st.closed {
                return Err(ClientError::NotConnected);
            }
            st.pending_join.push_back(tx);
            st.pending_channel.push_back(channel.clone());
        }
        if let Err(e) = self.send_frame(&frame) {
            let mut st = self.inner.state.lock().unwrap();
            st.pending_join.pop_back();
            st.pending_channel.pop_back();
            return Err(e);
        }

        let (call_id, peer) = rx.await.map_err(|_| ClientError::Disconnected)??;
        {
            let mut st = self.inner.state.lock().unwrap();
            st.channels.insert(call_id.clone(), channel);
            st.ctx.insert(
                call_id.clone(),
                CallCtx {
                    from: opts.from,
                    peer: Some(peer.clone()),
                    topic: "(joined)".into(),
                    started_at: now_iso(),
                    transcript: Vec::new(),
                    summary: None,
                },
            );
        }
        Ok(Joined { call_id, peer })
    }

    /// Seal a Message with the call's channel and ship the ciphertext to the
    /// relay. The relay routes it to the other endpoint; it never sees plaintext.
    pub async fn send(&self, call_id: &str, msg: &Message) -> Result<()> {
        let channel = {
            let st = self.inner.state.lock().unwrap();
            st.channels.get(call_id).cloned()
        };
        let channel = channel.ok_or_else(|| ClientError::NoChannel(call_id.to_string()))?;

        // Defense in depth: validate our own outbound message and cap content.
        if msg.content.len() > MAX_CONTENT_BYTES {
            return Err(ClientError::ContentTooLarge);
        }
        msg.clone().validate()?;

        let plaintext =
            serde_json::to_vec(msg).map_err(|e| ClientError::Ws(e.to_string()))?;
        let sealed = channel.seal(&plaintext);
        let frame = frame_to_b64(&sealed);

        self.send_frame(&ClientToRelay::Send {
            call_id: call_id.to_string(),
            frame,
        })?;
        self.record(call_id, msg);
        Ok(())
    }

    /// Declare the call resolved with a `summary`, then end it. Sends a `resolve`
    /// message (the peer learns the conclusion) and hangs up.
    pub async fn resolve(&self, call_id: &str, summary: &str) -> Result<()> {
        let (from, peer, turn) = {
            let mut st = self.inner.state.lock().unwrap();
            let ctx = st
                .ctx
                .get_mut(call_id)
                .ok_or_else(|| ClientError::NoCall(call_id.to_string()))?;
            let peer = ctx.peer.clone().ok_or(ClientError::NoPeer)?;
            ctx.summary = Some(summary.to_string());
            (ctx.from.clone(), peer, ctx.transcript.len() as u64)
        };

        let msg = Message {
            v: PROTOCOL_VERSION,
            id: new_message_id(),
            call_id: call_id.to_string(),
            from,
            to: peer,
            r#type: MessageType::Resolve,
            ts: now_iso(),
            turn,
            in_reply_to: None,
            content: summary.to_string(),
        };
        self.send(call_id, &msg).await?;
        self.hangup(call_id).await?;
        Ok(())
    }

    /// Build the end-of-call report from the recorded transcript.
    pub fn build_report(&self, call_id: &str, outcome: CallOutcome) -> Option<CallReport> {
        let st = self.inner.state.lock().unwrap();
        let ctx = st.ctx.get(call_id)?;
        Some(make_report(call_id, ctx, outcome, now_iso()))
    }

    /// Register a callback for decrypted, validated inbound messages.
    pub fn on_message<F: Fn(Message) + Send + Sync + 'static>(&self, cb: F) {
        self.inner.callbacks.lock().unwrap().message.push(Arc::new(cb));
    }

    /// Register a callback for remote hangups.
    pub fn on_hangup<F: Fn(String) + Send + Sync + 'static>(&self, cb: F) {
        self.inner.callbacks.lock().unwrap().hangup.push(Arc::new(cb));
    }

    /// Register a callback fired when the OPENER's peer joins (callId, peer).
    pub fn on_peer_joined<F: Fn(String, Extension) + Send + Sync + 'static>(&self, cb: F) {
        self.inner
            .callbacks
            .lock()
            .unwrap()
            .peer_joined
            .push(Arc::new(cb));
    }

    /// Register a callback fired when the PEER declares the call resolved.
    pub fn on_resolved<F: Fn(String, String) + Send + Sync + 'static>(&self, cb: F) {
        self.inner.callbacks.lock().unwrap().resolved.push(Arc::new(cb));
    }

    /// Tear down a single call and tell the relay.
    pub async fn hangup(&self, call_id: &str) -> Result<()> {
        self.send_frame(&ClientToRelay::Hangup {
            call_id: call_id.to_string(),
        })?;
        self.inner.state.lock().unwrap().channels.remove(call_id);
        Ok(())
    }

    /// Close the underlying WebSocket and drop all per-call state.
    pub fn close(&self) {
        {
            let mut st = self.inner.state.lock().unwrap();
            st.closed = true;
            st.channels.clear();
        }
        let _ = self.inner.out_tx.send(WsMessage::Close(None));
    }

    // ---- internals ---------------------------------------------------------

    fn send_frame(&self, frame: &ClientToRelay) -> Result<()> {
        if self.inner.state.lock().unwrap().closed {
            return Err(ClientError::NotConnected);
        }
        let text = serde_json::to_string(frame).map_err(|e| ClientError::Ws(e.to_string()))?;
        self.inner
            .out_tx
            .send(WsMessage::Text(text))
            .map_err(|_| ClientError::NotConnected)
    }

    fn record(&self, call_id: &str, msg: &Message) {
        let mut st = self.inner.state.lock().unwrap();
        record_into(&mut st, call_id, msg);
    }
}

fn record_into(st: &mut ClientState, call_id: &str, msg: &Message) {
    if let Some(ctx) = st.ctx.get_mut(call_id) {
        ctx.transcript.push(TranscriptEntry {
            from: msg.from.clone(),
            r#type: msg.r#type,
            content: msg.content.clone(),
            ts: msg.ts.clone(),
        });
    }
}

/// Pure report builder — testable without a live connection.
fn make_report(
    call_id: &str,
    ctx: &CallCtx,
    outcome: CallOutcome,
    ended_at: String,
) -> CallReport {
    CallReport {
        call_id: call_id.to_string(),
        topic: ctx.topic.clone(),
        me: ctx.from.clone(),
        peer: ctx.peer.clone(),
        outcome,
        summary: if outcome == CallOutcome::Resolved {
            ctx.summary.clone()
        } else {
            None
        },
        turns: ctx.transcript.len() as u64,
        started_at: ctx.started_at.clone(),
        ended_at,
        transcript: ctx.transcript.clone(),
    }
}

// ---- background tasks ------------------------------------------------------

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, WsMessage>;
type WsSource = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

async fn writer_task(mut write: WsSink, mut out_rx: UnboundedReceiver<WsMessage>) {
    while let Some(msg) = out_rx.recv().await {
        let is_close = matches!(msg, WsMessage::Close(_));
        if write.send(msg).await.is_err() {
            break;
        }
        if is_close {
            break;
        }
    }
    let _ = write.close().await;
}

async fn reader_task(mut read: WsSource, inner: Arc<Inner>) {
    while let Some(item) = read.next().await {
        match item {
            Ok(WsMessage::Text(t)) => dispatch(&inner, &t),
            Ok(WsMessage::Binary(b)) => {
                if let Ok(t) = String::from_utf8(b) {
                    dispatch(&inner, &t);
                }
            }
            Ok(WsMessage::Close(_)) => break,
            Ok(_) => {} // ping/pong/frame: ignore
            Err(_) => break,
        }
    }
    on_close(&inner);
}

fn dispatch(inner: &Arc<Inner>, text: &str) {
    let frame: RelayToClient = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(_) => {
            eprintln!("[magpie] dropped malformed relay frame");
            return;
        }
    };

    match frame {
        RelayToClient::Opened { call_id } => {
            let mut st = inner.state.lock().unwrap();
            // Register the channel SYNCHRONOUSLY here (join-race fix): a `deliver`
            // can arrive in the same batch as `opened`.
            if let Some(chan) = st.pending_channel.pop_front() {
                st.channels.insert(call_id.clone(), chan);
            }
            if let Some(tx) = st.pending_open.pop_front() {
                let _ = tx.send(Ok(call_id));
            }
        }
        RelayToClient::Joined { call_id, peer } => {
            let mut st = inner.state.lock().unwrap();
            if let Some(chan) = st.pending_channel.pop_front() {
                st.channels.insert(call_id.clone(), chan);
            }
            if let Some(tx) = st.pending_join.pop_front() {
                let _ = tx.send(Ok((call_id, peer)));
            }
        }
        RelayToClient::PeerJoined { call_id, peer } => {
            {
                let mut st = inner.state.lock().unwrap();
                if let Some(ctx) = st.ctx.get_mut(&call_id) {
                    ctx.peer = Some(peer.clone());
                }
            }
            let cbs = inner.callbacks.lock().unwrap().peer_joined.clone();
            for cb in cbs {
                cb(call_id.clone(), peer.clone());
            }
        }
        RelayToClient::Deliver { call_id, frame } => on_deliver(inner, &call_id, &frame),
        RelayToClient::Hangup { call_id, reason } => {
            inner.state.lock().unwrap().channels.remove(&call_id);
            let cbs = inner.callbacks.lock().unwrap().hangup.clone();
            for cb in cbs {
                cb(reason.clone());
            }
        }
        RelayToClient::Error { code, message } => on_error(inner, code, message),
    }
}

/// Decrypt, validate (defense in depth), and dispatch one delivered frame.
fn on_deliver(inner: &Arc<Inner>, call_id: &str, b64: &str) {
    let channel = {
        let st = inner.state.lock().unwrap();
        st.channels.get(call_id).cloned()
    };
    let Some(channel) = channel else {
        eprintln!("[magpie] deliver for unknown call {call_id}; dropped");
        return;
    };

    let msg = match decrypt_message(&channel, b64) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[magpie] dropped undecryptable/invalid frame on {call_id}: {e}");
            return;
        }
    };

    {
        let mut st = inner.state.lock().unwrap();
        record_into(&mut st, call_id, &msg);
    }

    // A `resolve` message is the peer concluding the call with a summary — it is
    // not a normal query, so surface it via on_resolved, not on_message.
    if msg.r#type == MessageType::Resolve {
        {
            let mut st = inner.state.lock().unwrap();
            if let Some(ctx) = st.ctx.get_mut(call_id) {
                ctx.summary = Some(msg.content.clone());
            }
        }
        let cbs = inner.callbacks.lock().unwrap().resolved.clone();
        for cb in cbs {
            cb(call_id.to_string(), msg.content.clone());
        }
        return;
    }

    let cbs = inner.callbacks.lock().unwrap().message.clone();
    for cb in cbs {
        cb(msg.clone());
    }
}

fn decrypt_message(channel: &PairingChannel, b64: &str) -> Result<Message> {
    let ciphertext = frame_from_b64(b64)?;
    let plaintext = channel.open(&ciphertext)?;
    let text = String::from_utf8(plaintext)
        .map_err(|e| ClientError::Protocol(ProtocolError::Validation(e.to_string())))?;
    Ok(parse_message(&text)?)
}

/// Relay reported a violation. Reject the oldest in-flight request if any (join
/// before open, mirroring TS), otherwise log — an error can be unsolicited.
fn on_error(inner: &Arc<Inner>, code: String, message: String) {
    let mut st = inner.state.lock().unwrap();
    if let Some(tx) = st.pending_join.pop_front() {
        st.pending_channel.pop_front();
        let _ = tx.send(Err(ClientError::Relay { code, message }));
        return;
    }
    if let Some(tx) = st.pending_open.pop_front() {
        st.pending_channel.pop_front();
        let _ = tx.send(Err(ClientError::Relay { code, message }));
        return;
    }
    eprintln!("[magpie] relay error [{code}]: {message}");
}

fn on_close(inner: &Arc<Inner>) {
    let mut st = inner.state.lock().unwrap();
    if st.closed {
        return;
    }
    st.closed = true;
    for tx in st.pending_open.drain(..) {
        let _ = tx.send(Err(ClientError::Disconnected));
    }
    for tx in st.pending_join.drain(..) {
        let _ = tx.send(Err(ClientError::Disconnected));
    }
    st.pending_channel.clear();
    st.channels.clear();
}

// ---- time ------------------------------------------------------------------

/// ISO-8601 UTC timestamp with millisecond precision and a `Z` suffix, matching
/// JavaScript's `new Date().toISOString()` (e.g. `2026-06-29T12:34:56.789Z`).
///
/// Public so the CLI can stamp outbound messages with the identical format the
/// client uses internally for transcript bookkeeping.
pub fn now_iso() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_unix(d.as_secs() as i64, d.subsec_millis())
}

fn iso_from_unix(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Howard Hinnant's days-from-civil inverse: unix-epoch day count -> (y, m, d).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(from: &str, ty: MessageType, content: &str) -> TranscriptEntry {
        TranscriptEntry {
            from: from.into(),
            r#type: ty,
            content: content.into(),
            ts: "2026-06-29T00:00:00.000Z".into(),
        }
    }

    fn ctx_with(summary: Option<&str>, peer: Option<&str>, n: usize) -> CallCtx {
        CallCtx {
            from: "@alice/impl".into(),
            peer: peer.map(|p| p.to_string()),
            topic: "the topic".into(),
            started_at: "2026-06-29T00:00:00.000Z".into(),
            transcript: (0..n)
                .map(|i| entry("@bob/risk", MessageType::Query, &format!("m{i}")))
                .collect(),
            summary: summary.map(|s| s.to_string()),
        }
    }

    #[test]
    fn report_resolved_includes_summary() {
        let ctx = ctx_with(Some("we agreed"), Some("@bob/risk"), 3);
        let r = make_report("call-abcdefghij", &ctx, CallOutcome::Resolved, "END".into());
        assert_eq!(r.call_id, "call-abcdefghij");
        assert_eq!(r.topic, "the topic");
        assert_eq!(r.me, "@alice/impl");
        assert_eq!(r.peer.as_deref(), Some("@bob/risk"));
        assert_eq!(r.outcome, CallOutcome::Resolved);
        assert_eq!(r.summary.as_deref(), Some("we agreed"));
        assert_eq!(r.turns, 3);
        assert_eq!(r.transcript.len(), 3);
        assert_eq!(r.ended_at, "END");
    }

    #[test]
    fn report_non_resolved_drops_summary() {
        // Even with a summary present, a non-resolved outcome must null it out
        // (mirrors the TS `outcome === 'resolved' ? ctx.summary : null`).
        let ctx = ctx_with(Some("ignored"), Some("@bob/risk"), 2);
        for outcome in [
            CallOutcome::TurnCap,
            CallOutcome::HungUp,
            CallOutcome::Disconnected,
        ] {
            let r = make_report("call-abcdefghij", &ctx, outcome, "END".into());
            assert_eq!(r.summary, None, "summary must be None for {outcome:?}");
            assert_eq!(r.outcome, outcome);
        }
    }

    #[test]
    fn report_no_peer_is_none() {
        let ctx = ctx_with(None, None, 0);
        let r = make_report("call-abcdefghij", &ctx, CallOutcome::HungUp, "END".into());
        assert_eq!(r.peer, None);
        assert_eq!(r.turns, 0);
        assert!(r.transcript.is_empty());
    }

    #[test]
    fn report_serializes_to_camelcase_json() {
        let ctx = ctx_with(Some("done"), Some("@bob/risk"), 1);
        let r = make_report("call-abcdefghij", &ctx, CallOutcome::Resolved, "END".into());
        let j = serde_json::to_value(&r).unwrap();
        assert!(j.get("callId").is_some());
        assert!(j.get("startedAt").is_some());
        assert!(j.get("endedAt").is_some());
        assert_eq!(j["outcome"], "resolved");
        // Transcript entry uses `type`, not `r#type`.
        assert_eq!(j["transcript"][0]["type"], "query");
    }

    #[test]
    fn iso_from_unix_matches_known_instant() {
        // 2021-01-01T00:00:00.000Z == 1609459200 unix seconds.
        assert_eq!(iso_from_unix(1_609_459_200, 0), "2021-01-01T00:00:00.000Z");
        // Epoch.
        assert_eq!(iso_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
        // With millis + time of day.
        assert_eq!(iso_from_unix(1_609_459_200 + 45_296, 789), "2021-01-01T12:34:56.789Z");
    }
}
