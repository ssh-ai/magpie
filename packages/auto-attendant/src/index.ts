/**
 * @switchboard/auto-attendant — the headless "answer on your behalf" worker.
 *
 * It staffs a single Switchboard call while its operator is away: inbound peer
 * queries are answered ONLY from the operator's own files, via a vendor-
 * pluggable {@link Responder} (Claude / Codex / Gemini). It runs under
 * DEFAULT_ACTION_POLICY (read own files, never run tools) and NEVER guesses —
 * on low confidence, a blocked action, the turn cap, or a responder error it
 * hangs up with an escalate reason and emits an `escalate` event for the human.
 */
export { AutoAttendant } from './auto-attendant.js';
export type {
  AutoAttendantOptions,
  AutoAttendantEvents,
  CallTransport,
  EscalateEvent,
  EscalateReason,
  AnsweredEvent,
} from './auto-attendant.js';

export type { Responder, ResponderInput, ResponderResult } from './responder.js';
export { buildPrompt, parseConfidence } from './responder.js';

export { ClaudeResponder, CodexResponder, GeminiResponder } from './adapters.js';
export type { ShellResponderOptions, RunFn } from './adapters.js';

export { TypedEmitter } from './events.js';
