//! The `clap` command surface.
//!
//! Mirror of `program.ts` — same command names, arguments, and help text, so
//! `switchboard --help` reads identically to the TypeScript CLI. `commander`'s
//! `<topic>` (required) / `[callId]` (optional) map to a `String` field and an
//! `Option<String>` field respectively.

use clap::{Parser, Subcommand};

/// A switchboard for AI agents — patch one agent through to another.
#[derive(Debug, Parser)]
#[command(
    name = "switchboard",
    version,
    about = "A switchboard for AI agents — patch one agent through to another."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// open a call, print the code + a shareable line, and hold the line open
    Start {
        /// what this call is about, e.g. "is the risk limit correct?"
        topic: String,
    },

    /// patch your agent into an existing call
    Join {
        /// the pairing code shared with you, e.g. K7F3-9M2P-XQ4R
        code: String,
    },

    /// list past calls and their outcomes (resolved / hung up / …)
    History,

    /// show a past call: outcome, summary, and full transcript
    Report {
        /// which call (default: most recent)
        call_id: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(args)
    }

    #[test]
    fn start_takes_a_required_topic() {
        let cli = parse(&["switchboard", "start", "is the limit right?"]).unwrap();
        assert!(matches!(cli.command, Commands::Start { topic } if topic == "is the limit right?"));
    }

    #[test]
    fn start_without_topic_is_an_error() {
        assert!(parse(&["switchboard", "start"]).is_err());
    }

    #[test]
    fn join_takes_a_required_code() {
        let cli = parse(&["switchboard", "join", "K7F3-9M2P-XQ4R"]).unwrap();
        assert!(matches!(cli.command, Commands::Join { code } if code == "K7F3-9M2P-XQ4R"));
    }

    #[test]
    fn join_without_code_is_an_error() {
        assert!(parse(&["switchboard", "join"]).is_err());
    }

    #[test]
    fn history_takes_no_args() {
        let cli = parse(&["switchboard", "history"]).unwrap();
        assert!(matches!(cli.command, Commands::History));
    }

    #[test]
    fn report_call_id_is_optional() {
        let with = parse(&["switchboard", "report", "call-abcdefghij"]).unwrap();
        assert!(matches!(with.command, Commands::Report { call_id: Some(id) } if id == "call-abcdefghij"));

        let without = parse(&["switchboard", "report"]).unwrap();
        assert!(matches!(without.command, Commands::Report { call_id: None }));
    }

    #[test]
    fn unknown_command_is_an_error() {
        assert!(parse(&["switchboard", "frobnicate"]).is_err());
    }

    /// clap's own invariants — guards against an accidentally-broken command tree.
    #[test]
    fn command_tree_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }
}
