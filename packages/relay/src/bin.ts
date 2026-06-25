#!/usr/bin/env node
import { startRelay } from './server.js';

/**
 * Relay entrypoint. Reads PORT (default 8787) and HOST (default 0.0.0.0) from
 * the environment. Run: `PORT=8787 switchboard-relay`.
 */
async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[relay] invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }
  const host = process.env.HOST ?? '0.0.0.0';

  const relay = await startRelay(port, { host });
  console.log(`[relay] switchboard listening on ws://${host}:${relay.port}`);

  const shutdown = (sig: string) => {
    console.log(`[relay] ${sig} received, shutting down`);
    void relay.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[relay] fatal:', err);
  process.exit(1);
});
