#!/usr/bin/env node
import { SwitchboardClient } from '@switchboard/client';
import { DEFAULT_MAX_TURNS } from '@switchboard/protocol';
import type { Extension } from '@switchboard/protocol';
import { AutoAttendant } from './auto-attendant.js';
import { ClaudeResponder } from './adapters.js';

/**
 * switchboard-attend <pairing-code>
 *
 * Joins an existing Switchboard call and STAFFS it with a real agent: answers the
 * teammate's questions from THIS project's files while the operator is away, and
 * escalates (hang up + notice) when it is not confident. Read-only by design.
 *
 * Env:
 *   SWITCHBOARD_RELAY_URL  (default ws://localhost:8787)
 *   SWITCHBOARD_EXTENSION  this agent's @owner/role
 *   SWITCHBOARD_CWD        project dir the agent may read (default: process.cwd())
 */
async function main(): Promise<void> {
  const code = process.argv[2];
  if (!code) throw new Error('usage: switchboard-attend <pairing-code>');

  const relayUrl = process.env.SWITCHBOARD_RELAY_URL ?? 'ws://localhost:8787';
  const self = (process.env.SWITCHBOARD_EXTENSION ?? '@me/agent') as Extension;
  const cwd = process.env.SWITCHBOARD_CWD ?? process.cwd();

  const client = await SwitchboardClient.connect(relayUrl);
  const { callId, peer } = await client.join({ from: self, code });

  const attendant = new AutoAttendant({
    self,
    callId,
    cwd,
    topic: `staffing call with ${peer}`,
    responder: new ClaudeResponder(),
    transport: client,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  attendant.on('answered', (e) =>
    process.stdout.write(
      `✅ answered ${peer}: ${e.answer.slice(0, 100)}${e.answer.length > 100 ? '…' : ''}\n`,
    ),
  );
  attendant.on('escalate', (e) =>
    process.stdout.write(`⚠️  escalate (${e.reason}): ${e.detail} — a human is needed.\n`),
  );
  attendant.start();

  process.stdout.write(
    `🟢 Attending call ${callId} with ${peer}. Staffed by ${self} (claude, read-only) over ${cwd}.\n` +
      '   Answering on your behalf; will escalate if unsure. Ctrl-C to leave.\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
