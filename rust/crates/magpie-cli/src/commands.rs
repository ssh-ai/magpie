//! The command handlers.
//!
//! Mirror of `commands.ts`. Each is small and friendly — this is the
//! non-developer-simple surface, so output reads like a phone call. `start` and
//! `join` are LONG-LIVED: they hold the WebSocket open and stream inbound
//! queries until the call ends. `history` and `report` are one-shot reads of the
//! on-disk call store.

use magpie_client::{JoinOpts, StartOpts, MagpieClient};
use magpie_protocol::normalize_pairing_code;

use crate::env::{relay_url, require_extension};
use crate::reports::{
    list_reports, outcome_label, read_report, render_report, save_report,
};
use crate::runtime::{message_type_str, stream_until_done, SendOpts, StreamResult};

/// Errors surface as a single friendly `✗ …` line + exit 1 (see `main`).
type CmdResult = Result<(), Box<dyn std::error::Error + Send + Sync>>;

/// The shareable invite line a human pastes into chat.
pub fn share_line(code: &str) -> String {
    format!("Patch your agent in:  magpie join {code}")
}

/// Print the end reason, then build + show + persist the call report. This is
/// the "report on termination" the async value proposition depends on.
fn finish_call(client: &MagpieClient, call_id: &str, result: StreamResult) {
    println!("\n{}", result.reason);
    if let Some(report) = client.build_report(call_id, result.outcome) {
        println!("{}", render_report(&report));
        match save_report(&report) {
            Ok(path) => println!(
                "📋 Report saved: {}  (re-read with: magpie report {})",
                path.display(),
                report.call_id
            ),
            Err(e) => eprintln!("(could not save report: {e})"),
        }
    }
}

/// `start <topic>` — open a call, print the code + a shareable line, then hold
/// the line open and stream any inbound queries. Does not block on the peer.
pub async fn start(topic: &str) -> CmdResult {
    let from = require_extension()?;
    let url = relay_url();
    let client = MagpieClient::connect(&url).await?;
    let started = client
        .start(StartOpts {
            from: from.clone(),
            topic: topic.to_string(),
            max_turns: None,
        })
        .await?;

    println!("☎️  Magpie line open for: {topic}");
    println!();
    println!("   Your code:  {}", started.code);
    println!("   {}", share_line(&started.code));
    println!();
    println!("Waiting on the line… (Ctrl-C to hang up)");

    let result = stream_until_done(
        &client,
        Some(SendOpts {
            from,
            call_id: started.call_id.clone(),
            peer: None,
        }),
    )
    .await;
    finish_call(&client, &started.call_id, result);
    client.close();
    Ok(())
}

/// `join <code>` — patch your agent into an existing call using a code shared
/// over chat, then hold the line and stream inbound queries.
pub async fn join(raw_code: &str) -> CmdResult {
    let from = require_extension()?;
    let url = relay_url();
    // Normalize first for a friendly error on a bad-shaped code.
    let code = normalize_pairing_code(raw_code)?;
    let client = MagpieClient::connect(&url).await?;
    let joined = client
        .join(JoinOpts {
            from: from.clone(),
            code,
        })
        .await?;

    println!("✅ Patched through to {}. You are on the line.", joined.peer);
    println!("Type a message + Enter to send; inbound queries appear below. (Ctrl-C to hang up)");

    let result = stream_until_done(
        &client,
        Some(SendOpts {
            from,
            call_id: joined.call_id.clone(),
            peer: Some(joined.peer.clone()),
        }),
    )
    .await;
    finish_call(&client, &joined.call_id, result);
    client.close();
    Ok(())
}

/// `history` — list past calls and their outcomes (from `~/.magpie/calls/`).
/// This is how an away human catches up on what their agent concluded.
pub fn history() {
    let reports = list_reports();
    if reports.is_empty() {
        println!("No past calls yet.");
        return;
    }
    println!("Past calls ({}):", reports.len());
    for r in &reports {
        println!(
            "  {}  {}  with {}  \"{}\"",
            r.ended_at,
            outcome_label(r.outcome),
            r.peer.as_deref().unwrap_or("?"),
            r.topic
        );
        println!("      magpie report {}", r.call_id);
    }
}

/// `report [callId]` — show a past call's report + full transcript. Defaults to
/// the most recent call.
pub fn show_report(call_id: Option<&str>) {
    let report = match call_id {
        Some(id) => read_report(id),
        None => list_reports().into_iter().next(),
    };
    let Some(report) = report else {
        match call_id {
            Some(id) => println!("No report for call {id}."),
            None => println!("No past calls yet."),
        }
        return;
    };

    println!("{}", render_report(&report));
    println!("\n──── transcript ────");
    if report.transcript.is_empty() {
        println!("(no messages)");
    }
    for e in &report.transcript {
        println!("[{}] {}: {}", message_type_str(e.r#type), e.from, e.content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_line_is_copy_pasteable() {
        assert_eq!(
            share_line("K7F3-9M2P-XQ4R"),
            "Patch your agent in:  magpie join K7F3-9M2P-XQ4R"
        );
    }
}
