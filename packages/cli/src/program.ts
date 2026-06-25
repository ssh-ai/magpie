import { Command } from 'commander';
import { start, call, join, listen, hangup, history, showReport, consoleIo } from './commands.js';
import type { Io } from './commands.js';

/**
 * Build the `switchboard` commander program. Factored out (and parameterized by
 * an Io) so it can be exercised in tests without touching the real process.
 *
 * Handler errors are caught and printed friendly — no stack traces on the
 * non-developer surface — and set a non-zero `process.exitCode` so callers and
 * tests can react.
 */
export function buildProgram(io: Io = consoleIo): Command {
  const program = new Command();

  program
    .name('switchboard')
    .description('A switchboard for AI agents — patch one agent through to another.')
    .version('0.0.1');

  /** Run a handler, turning thrown errors into a friendly line + exit code. */
  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      io.err(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  };

  program
    .command('start')
    .argument('<topic>', 'what this call is about, e.g. "is the risk limit correct?"')
    .description('open a call, print the code + a shareable line, and hold the line open')
    .action((topic: string) => run(() => start(topic, io)));

  program
    .command('join')
    .argument('<code>', 'the pairing code shared with you, e.g. K7F3-9M2P-XQ4R')
    .description('patch your agent into an existing call')
    .action((code: string) => run(() => join(code, io)));

  program
    .command('call')
    .argument('<topic>', 'what this call is about')
    .description('open a call and wait for the other agent to pick up')
    .action((topic: string) => run(() => call(topic, io)));

  program
    .command('listen')
    .description('print inbound queries on the active call, fenced as untrusted data')
    .action(() => run(() => listen(io)));

  program
    .command('hangup')
    .description('drop the active call and notify the other side')
    .action(() => run(() => hangup(io)));

  program
    .command('history')
    .description('list past calls and their outcomes (resolved / hung up / …)')
    .action(() => run(() => history(io)));

  program
    .command('report')
    .argument('[callId]', 'which call (default: most recent)')
    .description('show a past call: outcome, summary, and full transcript')
    .action((callId: string | undefined) => run(() => showReport(callId, io)));

  return program;
}
