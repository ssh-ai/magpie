/**
 * @switchboard/mcp — an MCP server that exposes Switchboard to ANY MCP-capable
 * agent (Claude Code, Codex, Gemini CLI, …) as six tools:
 *
 *   sb_start  — start a call, get a pairing code to show the human
 *   sb_join   — join a call with a code
 *   sb_ask    — ask the peer a question and get their (fenced) answer
 *   sb_listen — receive the peer's next question, rendered as untrusted data
 *   sb_answer — answer an inbound question from YOUR OWN context
 *   sb_hangup — end the call
 *
 * Security invariant: every inbound peer content shown to the host model passes
 * through renderInbound/fenceUntrusted and is labelled UNTRUSTED DATA. The host
 * answers only from its own project and never runs tools on peer instruction.
 */
export { createSwitchboardMcp } from './server.js';
export type { SwitchboardMcp, SwitchboardMcpOptions } from './server.js';
export { registerSwitchboardTools } from './tools.js';
export { SessionStore, CallSession } from './session.js';
export type { SessionInfo } from './session.js';
