//! `magpie` — the non-developer-simple CLI.
//!
//! Mirror of `packages/cli` (the TypeScript reference). A friendly `magpie`
//! command that wraps `magpie-client` + `magpie-protocol` behind
//! `start｜join｜history｜report`. Output reads like a phone call, not a stack
//! trace; thrown errors are caught and printed as a single `✗ …` line with a
//! non-zero exit code (mirrors `program.ts`'s `run` wrapper).
//!
//! ## Scope vs. the TS CLI
//! This binary implements the durable, distributable core requested for the
//! Rust migration Phase 3: `start`, `join`, `history`, `report`. The TS-only
//! `call`/`listen`/`hangup` commands (and their `session.json` bookkeeping)
//! are intentionally not ported here — `hangup` exists only to signal a
//! separate long-lived process, which the single-binary model does not need
//! (Ctrl-C ends the live call directly).

mod cli;
mod commands;
mod env;
mod reports;
mod runtime;

use clap::Parser;

use cli::{Cli, Commands};

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Start { topic } => commands::start(&topic).await,
        Commands::Join { code } => commands::join(&code).await,
        Commands::History => {
            commands::history();
            Ok(())
        }
        Commands::Report { call_id } => {
            commands::show_report(call_id.as_deref());
            Ok(())
        }
    };

    if let Err(e) = result {
        eprintln!("✗ {e}");
        std::process::exit(1);
    }
}
