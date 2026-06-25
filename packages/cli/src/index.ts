/**
 * @switchboard/cli — the non-developer-simple surface: a friendly `switchboard`
 * command that wraps @switchboard/client + @switchboard/protocol behind
 * `start｜join｜call｜listen｜hangup`.
 *
 * The public API here exists mainly for testing and embedding; the real
 * entrypoint is the `switchboard` bin (src/bin.ts).
 */
export { buildProgram } from './program.js';
export { start, call, join, listen, hangup, shareLine, consoleIo } from './commands.js';
export type { Io } from './commands.js';
export { relayUrl, requireExtension, DEFAULT_RELAY_URL } from './env.js';
export { renderInboundForHuman } from './runtime.js';
export type { Session } from './store.js';
