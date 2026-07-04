#!/usr/bin/env node
/**
 * A tiny, dependency-free static file server for the Magpie onboarding page.
 *
 * This is intentionally NOT a framework. Its only job is to hand the browser
 * `index.html` and `app.js` so a non-developer can open a page and join a call.
 * The page then talks to the relay directly over a browser WebSocket — this
 * server never touches the relay, the pairing code, or any ciphertext.
 *
 * Run:
 *   node ./src/serve.ts                 # node >=22 strips the TS types itself
 *   node --import tsx ./src/serve.ts    # older node
 *   PORT=4173 RELAY_URL=ws://localhost:8787 node ./src/serve.ts
 *
 * Env:
 *   PORT       (default 4173)  port to listen on
 *   HOST       (default 127.0.0.1) bind address; loopback by default for safety
 *   RELAY_URL  (optional)      injected into the page as window.MAGPIE_RELAY_URL
 *                              so the human doesn't have to type the relay address.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';

const PORT = Number.parseInt(process.env.PORT ?? '4173', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const RELAY_URL = process.env.RELAY_URL ?? '';

/** Static assets live next to this file, in ../public. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  try {
    // Only GET/HEAD. This is a static surface; nothing here mutates state.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed\n');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // Path-traversal guard: resolve against ROOT and refuse anything escaping it.
    // (Same discipline as the rest of Magpie — never trust an inbound path.)
    const resolved = normalize(join(ROOT, pathname));
    if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden\n');
      return;
    }

    let body = await readFile(resolved);

    // Inject the configured relay URL into index.html so the operator can
    // preconfigure it (the human can still override it in the UI).
    if (resolved.endsWith('index.html')) {
      const inject = `<script>window.MAGPIE_RELAY_URL=${JSON.stringify(RELAY_URL)};</script>`;
      body = Buffer.from(body.toString('utf8').replace('<!--RELAY_URL-->', inject), 'utf8');
    }

    res.writeHead(200, {
      'Content-Type': contentType(resolved),
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found\n');
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('server error\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web] Magpie onboarding page on http://${HOST}:${PORT}`);
  if (RELAY_URL) console.log(`[web] relay preconfigured: ${RELAY_URL}`);
  else console.log(`[web] no RELAY_URL set; the page will ask for it (default ws://localhost:8787)`);
});
