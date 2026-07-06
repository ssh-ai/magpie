#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMagpieMcp } from './server.js';
import { resolveDefaultRelay } from './relay-pointer.js';

/**
 * Magpie MCP stdio entrypoint.
 *
 * Configure your MCP host (Claude Code, Codex, Gemini CLI) to launch:
 *
 *   MAGPIE_RELAY_URL=ws://localhost:8787 \
 *   MAGPIE_EXTENSION=@chris/impl \
 *   magpie-mcp
 *
 * - MAGPIE_RELAY_URL : WebSocket URL of the default relay. OPTIONAL — when unset,
 *   the hosted default relay is resolved from a stable pointer file (see
 *   relay-pointer.ts). A joiner pasting a full invite (`CODE@ws://…`) needs no
 *   relay config at all. Set it to pin a self-hosted relay.
 * - MAGPIE_RELAY_POINTER : override the pointer URL, or set to '' to disable
 *   the hosted default (invite-only). OPTIONAL.
 * - MAGPIE_EXTENSION  : this endpoint's address `@owner/role` (required).
 * - MAGPIE_ASK_TIMEOUT_MS : optional override for how long sb_ask waits.
 *
 * IMPORTANT: stdout is the MCP transport — never write logs there. Diagnostics
 * go to stderr only.
 */
async function main(): Promise<void> {
  const extension = process.env.MAGPIE_EXTENSION;

  if (!extension) {
    process.stderr.write('[magpie-mcp] MAGPIE_EXTENSION is required (e.g. @chris/impl)\n');
    process.exit(1);
  }

  // Resolve the default relay: explicit env wins, else the hosted pointer file.
  // Never throws — an unreachable pointer degrades to invite-only mode.
  const relayUrl = await resolveDefaultRelay(process.env, {
    warn: (m) => process.stderr.write(`[magpie-mcp] ${m}\n`),
  });

  const askTimeoutRaw = process.env.MAGPIE_ASK_TIMEOUT_MS;
  const askTimeoutMs =
    askTimeoutRaw !== undefined ? Number.parseInt(askTimeoutRaw, 10) : undefined;
  if (askTimeoutMs !== undefined && (!Number.isInteger(askTimeoutMs) || askTimeoutMs <= 0)) {
    process.stderr.write(`[magpie-mcp] invalid MAGPIE_ASK_TIMEOUT_MS: ${askTimeoutRaw}\n`);
    process.exit(1);
  }

  let mcp;
  try {
    mcp = createMagpieMcp({
      ...(relayUrl ? { relayUrl } : {}),
      extension, // validated inside createMagpieMcp; throws on bad shape
      ...(askTimeoutMs !== undefined ? { askTimeoutMs } : {}),
    });
  } catch (err) {
    process.stderr.write(
      `[magpie-mcp] bad config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
    return;
  }

  const transport = new StdioServerTransport();
  await mcp.server.connect(transport);
  process.stderr.write(
    `[magpie-mcp] ready as ${extension} via ${relayUrl || '(no default relay — join with a full invite, or pass relayUrl to sb_start)'} (stdio)\n`,
  );

  const shutdown = (sig: string) => {
    process.stderr.write(`[magpie-mcp] ${sig} received, shutting down\n`);
    mcp.store.close();
    void mcp.server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[magpie-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
