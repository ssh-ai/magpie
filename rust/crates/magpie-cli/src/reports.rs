//! On-disk store of end-of-call reports under `~/.magpie/calls/`.
//!
//! Mirror of `reports.ts`. This is the "report on termination" surface: even if
//! a human was away when their agent finished a call, the conclusion +
//! transcript wait here. Files are written `0600`; the transcript is
//! plaintext-on-this-machine (the user's own side of the call).
//!
//! The `*_in` helpers take the base directory explicitly so the persistence
//! logic is unit-testable against a temp dir without touching `$HOME`.

use std::io;
use std::path::{Path, PathBuf};

use magpie_client::{CallOutcome, CallReport};

/// `~/.magpie/calls`. Honors `$HOME`; falls back to the current dir.
fn calls_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".magpie").join("calls")
}

/// Persist a report. Returns the file path.
pub fn save_report(r: &CallReport) -> io::Result<PathBuf> {
    save_report_in(&calls_dir(), r)
}

/// All saved reports, newest first.
pub fn list_reports() -> Vec<CallReport> {
    list_reports_in(&calls_dir())
}

/// One report by callId, or `None`.
pub fn read_report(call_id: &str) -> Option<CallReport> {
    read_report_in(&calls_dir(), call_id)
}

// ---- dir-parameterized cores (testable) ------------------------------------

pub(crate) fn save_report_in(dir: &Path, r: &CallReport) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.json", r.call_id));
    let json = serde_json::to_string_pretty(r).map_err(io::Error::other)?;
    write_private(&path, json.as_bytes())?;
    Ok(path)
}

pub(crate) fn list_reports_in(dir: &Path) -> Vec<CallReport> {
    let mut out: Vec<CallReport> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(r) = serde_json::from_str::<CallReport>(&s) {
                out.push(r);
            }
        }
    }
    // Newest first (descending by ISO `endedAt`, which sorts lexically).
    out.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    out
}

pub(crate) fn read_report_in(dir: &Path, call_id: &str) -> Option<CallReport> {
    // A callId is user input here (`magpie report <id>`): validate its shape
    // before building a path with it, or `../` walks out of the calls dir.
    if !magpie_protocol::is_valid_call_id(call_id) {
        return None;
    }
    let path = dir.join(format!("{call_id}.json"));
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

/// Write `bytes` to `path` with `0600` perms (create-with-mode on unix, and an
/// explicit chmod so an overwrite of a pre-existing file is locked down too).
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)?;
    }
    Ok(())
}

// ---- rendering -------------------------------------------------------------

/// Human label for a call outcome (matches the TS `OUTCOME_LABEL` map).
pub fn outcome_label(o: CallOutcome) -> &'static str {
    match o {
        CallOutcome::Resolved => "✅ resolved",
        CallOutcome::TurnCap => "⛔ turn cap reached",
        CallOutcome::HungUp => "📴 hung up",
        CallOutcome::Disconnected => "🔌 disconnected",
    }
}

/// A human-readable report block printed when a call ends. Byte-for-byte the
/// same layout as `renderReport` in `reports.ts`.
pub fn render_report(r: &CallReport) -> String {
    let mut lines: Vec<String> = vec![
        String::new(),
        "════════════ CALL REPORT ════════════".to_string(),
        format!("Topic:   {}", r.topic),
        format!("With:    {}", r.peer.as_deref().unwrap_or("(unknown)")),
        format!("Outcome: {}", outcome_label(r.outcome)),
    ];
    if let Some(summary) = &r.summary {
        lines.push(String::new());
        lines.push("Summary:".to_string());
        lines.push(summary.clone());
    } else if r.outcome != CallOutcome::Resolved {
        lines.push(String::new());
        lines.push("(ended without a resolution summary)".to_string());
    }
    lines.push(String::new());
    lines.push(format!(
        "Turns: {}  ·  {} → {}",
        r.turns, r.started_at, r.ended_at
    ));
    lines.push("═════════════════════════════════════".to_string());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use magpie_client::{MessageType, TranscriptEntry};

    fn report(outcome: CallOutcome, summary: Option<&str>, ended_at: &str) -> CallReport {
        CallReport {
            call_id: format!("call-{}", ended_at.replace([':', '.', '-', 'T', 'Z'], "")),
            topic: "deploy window".into(),
            me: "@alice/impl".into(),
            peer: Some("@bob/risk".into()),
            outcome,
            summary: summary.map(str::to_string),
            turns: 2,
            started_at: "2026-06-29T00:00:00.000Z".into(),
            ended_at: ended_at.into(),
            transcript: vec![TranscriptEntry {
                from: "@bob/risk".into(),
                r#type: MessageType::Query,
                content: "ok?".into(),
                ts: "2026-06-29T00:00:01.000Z".into(),
            }],
        }
    }

    #[test]
    fn outcome_labels_match_reference() {
        assert_eq!(outcome_label(CallOutcome::Resolved), "✅ resolved");
        assert_eq!(outcome_label(CallOutcome::TurnCap), "⛔ turn cap reached");
        assert_eq!(outcome_label(CallOutcome::HungUp), "📴 hung up");
        assert_eq!(outcome_label(CallOutcome::Disconnected), "🔌 disconnected");
    }

    #[test]
    fn render_resolved_includes_summary() {
        let r = report(CallOutcome::Resolved, Some("agreed: 5pm"), "2026-06-29T01:00:00.000Z");
        let out = render_report(&r);
        assert!(out.contains("════════════ CALL REPORT ════════════"));
        assert!(out.contains("Topic:   deploy window"));
        assert!(out.contains("With:    @bob/risk"));
        assert!(out.contains("Outcome: ✅ resolved"));
        assert!(out.contains("Summary:"));
        assert!(out.contains("agreed: 5pm"));
        assert!(out.contains("Turns: 2  ·  2026-06-29T00:00:00.000Z → 2026-06-29T01:00:00.000Z"));
    }

    #[test]
    fn render_unresolved_notes_no_summary() {
        let r = report(CallOutcome::HungUp, None, "2026-06-29T01:00:00.000Z");
        let out = render_report(&r);
        assert!(out.contains("Outcome: 📴 hung up"));
        assert!(out.contains("(ended without a resolution summary)"));
        assert!(!out.contains("Summary:"));
    }

    #[test]
    fn render_unknown_peer_falls_back() {
        let mut r = report(CallOutcome::HungUp, None, "2026-06-29T01:00:00.000Z");
        r.peer = None;
        assert!(render_report(&r).contains("With:    (unknown)"));
    }

    #[test]
    fn save_then_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let r = report(CallOutcome::Resolved, Some("done"), "2026-06-29T01:00:00.000Z");
        let path = save_report_in(dir.path(), &r).unwrap();
        assert!(path.exists());

        let back = read_report_in(dir.path(), &r.call_id).expect("read back");
        assert_eq!(back, r);
        assert!(read_report_in(dir.path(), "call-missing0000").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let r = report(CallOutcome::Resolved, Some("done"), "2026-06-29T01:00:00.000Z");
        let path = save_report_in(dir.path(), &r).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "report must be private (0600)");
    }

    #[test]
    fn list_is_newest_first_and_skips_non_json() {
        let dir = tempfile::tempdir().unwrap();
        let older = report(CallOutcome::HungUp, None, "2026-06-29T01:00:00.000Z");
        let newer = report(CallOutcome::Resolved, Some("done"), "2026-06-29T05:00:00.000Z");
        save_report_in(dir.path(), &older).unwrap();
        save_report_in(dir.path(), &newer).unwrap();
        // A non-report file in the dir must be ignored.
        std::fs::write(dir.path().join("notes.txt"), "ignore me").unwrap();
        // A malformed .json must be skipped, not crash the listing.
        std::fs::write(dir.path().join("broken.json"), "{not json").unwrap();

        let list = list_reports_in(dir.path());
        assert_eq!(list.len(), 2, "two valid reports");
        assert_eq!(list[0].ended_at, newer.ended_at, "newest first");
        assert_eq!(list[1].ended_at, older.ended_at);
    }

    #[test]
    fn list_missing_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(list_reports_in(&missing).is_empty());
    }

    #[test]
    fn read_rejects_path_traversal_call_ids() {
        let dir = tempfile::tempdir().unwrap();
        // Plant a decoy OUTSIDE the calls dir that a traversal would reach.
        let outside = dir.path().join("secret.json");
        let decoy = report(CallOutcome::Resolved, Some("secret"), "2026-06-29T01:00:00.000Z");
        std::fs::write(&outside, serde_json::to_string(&decoy).unwrap()).unwrap();
        let calls = dir.path().join("calls");
        std::fs::create_dir_all(&calls).unwrap();

        assert!(read_report_in(&calls, "../secret").is_none(), "traversal blocked");
        assert!(read_report_in(&calls, "/etc/passwd").is_none());
        assert!(read_report_in(&calls, "call-../../x-aaaa").is_none());
    }
}
