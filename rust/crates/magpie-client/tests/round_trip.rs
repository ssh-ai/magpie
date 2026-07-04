//! End-to-end integration tests: a real `start`/`join`/ask/answer/`resolve`
//! round-trip driven by two `MagpieClient`s against the actual Rust relay
//! binary (`magpie-relay`). The relay is spawned as a child process bound
//! to an OS-assigned port (argv `0`); the port is scraped from its stderr.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use magpie_client::{
    CallOutcome, JoinOpts, Message, MessageType, StartOpts, MagpieClient,
};

/// Kills the relay child on drop so a failing assert never leaks a process.
struct RelayGuard {
    child: Child,
    port: u16,
}

impl Drop for RelayGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn relay_binary() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("../../target"));
    target.join("debug").join("magpie-relay")
}

/// Ensure the relay binary is built (no-op under `cargo test` at the workspace
/// root, which already compiles every member, but makes `-p` runs work too).
fn ensure_relay_built() {
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "magpie-relay"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .expect("run cargo build for magpie-relay");
    assert!(status.success(), "failed to build magpie-relay");
}

fn spawn_relay() -> RelayGuard {
    ensure_relay_built();
    let mut child = Command::new(relay_binary())
        .arg("0") // OS-assigned port
        .env("MAGPIE_RELAY_HOST", "127.0.0.1")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn magpie-relay");

    let stderr = child.stderr.take().expect("relay stderr piped");
    let (tx, rx) = mpsc::channel::<u16>();
    std::thread::spawn(move || {
        let marker = "listening on ws://";
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            if let Some(idx) = line.find(marker) {
                let addr = &line[idx + marker.len()..];
                if let Some(port) = addr.rsplit(':').next().and_then(|p| p.trim().parse().ok()) {
                    let _ = tx.send(port);
                    break;
                }
            }
        }
    });

    let port = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("relay failed to report a bound port");
    RelayGuard { child, port }
}

fn url(port: u16) -> String {
    format!("ws://127.0.0.1:{port}")
}

fn query(call_id: &str, from: &str, to: &str, content: &str) -> Message {
    Message {
        v: 1,
        id: magpie_client_new_id(),
        call_id: call_id.to_string(),
        from: from.to_string(),
        to: to.to_string(),
        r#type: MessageType::Query,
        ts: "2026-06-29T00:00:00.000Z".to_string(),
        turn: 0,
        in_reply_to: None,
        content: content.to_string(),
    }
}

fn response(call_id: &str, from: &str, to: &str, content: &str) -> Message {
    let mut m = query(call_id, from, to, content);
    m.r#type = MessageType::Response;
    m
}

// A valid `msg-` id without exposing the protocol crate's generator to the test.
fn magpie_client_new_id() -> String {
    "msg-0123456789abcdef".to_string()
}

async fn recv<T>(rx: &mut tokio::sync::mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("timed out waiting for an event")
        .expect("event channel closed")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_join_ask_answer_resolve_round_trip() {
    let relay = spawn_relay();
    let opener = MagpieClient::connect(&url(relay.port))
        .await
        .expect("opener connects");
    let joiner = MagpieClient::connect(&url(relay.port))
        .await
        .expect("joiner connects");

    // Opener event sinks.
    let (op_msg_tx, mut op_msg_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    opener.on_message(move |m| {
        let _ = op_msg_tx.send(m);
    });
    let (op_pj_tx, mut op_pj_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
    opener.on_peer_joined(move |cid, peer| {
        let _ = op_pj_tx.send((cid, peer));
    });

    // Joiner event sinks.
    let (jn_msg_tx, mut jn_msg_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    joiner.on_message(move |m| {
        let _ = jn_msg_tx.send(m);
    });
    let (jn_res_tx, mut jn_res_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
    joiner.on_resolved(move |cid, summary| {
        let _ = jn_res_tx.send((cid, summary));
    });
    let (jn_hup_tx, mut jn_hup_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    joiner.on_hangup(move |reason| {
        let _ = jn_hup_tx.send(reason);
    });

    // 1) Opener starts a call, gets a shareable code.
    let started = opener
        .start(StartOpts {
            from: "@alice/impl".into(),
            topic: "deploy window".into(),
            max_turns: Some(12),
        })
        .await
        .expect("start");
    let call_id = started.call_id.clone();

    // 2) Joiner joins with the code; learns the opener's extension.
    let joined = joiner
        .join(JoinOpts {
            from: "@bob/risk".into(),
            code: started.code.clone(),
        })
        .await
        .expect("join");
    assert_eq!(joined.peer, "@alice/impl", "joiner learns opener extension");
    assert_eq!(joined.call_id, call_id, "both sides share the callId");

    // 3) Opener is told its peer joined (and who they are).
    let (pj_call, pj_peer) = recv(&mut op_pj_rx).await;
    assert_eq!(pj_call, call_id);
    assert_eq!(pj_peer, "@bob/risk");

    // 4) Joiner asks; opener receives the decrypted query.
    joiner
        .send(
            &joined.call_id,
            &query(&joined.call_id, "@bob/risk", "@alice/impl", "can we deploy at 5pm?"),
        )
        .await
        .expect("joiner send query");
    let got_q = recv(&mut op_msg_rx).await;
    assert_eq!(got_q.r#type, MessageType::Query);
    assert_eq!(got_q.content, "can we deploy at 5pm?");
    assert_eq!(got_q.from, "@bob/risk");

    // 5) Opener answers; joiner receives the decrypted response.
    opener
        .send(
            &call_id,
            &response(&call_id, "@alice/impl", "@bob/risk", "yes, 5pm works"),
        )
        .await
        .expect("opener send response");
    let got_r = recv(&mut jn_msg_rx).await;
    assert_eq!(got_r.r#type, MessageType::Response);
    assert_eq!(got_r.content, "yes, 5pm works");

    // 6) Opener resolves; joiner gets onResolved + a hangup.
    opener
        .resolve(&call_id, "agreed: deploy at 5pm")
        .await
        .expect("resolve");
    let (res_call, res_summary) = recv(&mut jn_res_rx).await;
    assert_eq!(res_call, call_id);
    assert_eq!(res_summary, "agreed: deploy at 5pm");
    let hup = recv(&mut jn_hup_rx).await;
    assert!(!hup.is_empty(), "joiner receives a hangup reason");

    // 7) Reports reflect the conversation.
    let op_report = opener
        .build_report(&call_id, CallOutcome::Resolved)
        .expect("opener report");
    assert_eq!(op_report.outcome, CallOutcome::Resolved);
    assert_eq!(op_report.summary.as_deref(), Some("agreed: deploy at 5pm"));
    assert_eq!(op_report.me, "@alice/impl");
    assert_eq!(op_report.peer.as_deref(), Some("@bob/risk"));
    // opener transcript: received query, sent response, sent resolve = 3.
    assert_eq!(op_report.turns, 3, "opener transcript turns");

    let jn_report = joiner
        .build_report(&joined.call_id, CallOutcome::Resolved)
        .expect("joiner report");
    assert_eq!(jn_report.summary.as_deref(), Some("agreed: deploy at 5pm"));
    // joiner transcript: sent query, received response, received resolve = 3.
    assert_eq!(jn_report.turns, 3, "joiner transcript turns");

    opener.close();
    joiner.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn join_unknown_rendezvous_is_rejected() {
    let relay = spawn_relay();
    let joiner = MagpieClient::connect(&url(relay.port))
        .await
        .expect("joiner connects");

    // A well-formed but never-opened code -> relay UNKNOWN_RENDEZVOUS.
    let err = joiner
        .join(JoinOpts {
            from: "@bob/risk".into(),
            code: "ABCD-EFGH-JKMN".into(),
        })
        .await
        .expect_err("join on an unopened rendezvous must fail");

    match err {
        magpie_client::ClientError::Relay { code, .. } => {
            assert_eq!(code, "UNKNOWN_RENDEZVOUS");
        }
        other => panic!("expected a relay UNKNOWN_RENDEZVOUS error, got {other:?}"),
    }

    joiner.close();
}
