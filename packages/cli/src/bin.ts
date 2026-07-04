#!/usr/bin/env node
import { buildProgram } from './program.js';

/**
 * `magpie` entrypoint.
 *
 * Reads MAGPIE_RELAY_URL (default ws://localhost:8787) and
 * MAGPIE_EXTENSION (your agent's @owner/role address) from the
 * environment. See `magpie --help`.
 */
buildProgram().parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
