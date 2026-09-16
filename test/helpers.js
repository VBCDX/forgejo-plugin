// Test helpers: a real loopback HTTP server standing in for a Forgejo instance,
// and a real credential file with the required owner/mode/parent so the
// credential loader's safety checks pass legitimately.

import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/index.js';

/**
 * Start a fake host. `routes` maps "METHOD /path" (path without query) to a
 * handler ({ req, url, body, count }) => { status, json?, text?, headers? }.
 * A function handler for the exact key is called; otherwise 404.
 * Records every request in `.requests`.
 */
export function fakeHost(routes) {
  const requests = [];
  const counts = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers });

    const handler = routes[key];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
      return;
    }
    const r = (await handler({ req, url, body, count: n })) || {};
    const headers = { ...(r.headers || {}) };
    let payload = '';
    if (r.json !== undefined) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      payload = JSON.stringify(r.json);
    } else if (r.text !== undefined) {
      headers['content-type'] = headers['content-type'] || 'text/plain';
      payload = r.text;
    }
    res.writeHead(r.status ?? 200, headers);
    res.end(payload);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        countFor: (k) => counts.get(k) ?? 0,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Config for the fake host (writes=full by default so all effects are testable). */
export function fakeConfig(url, overrides = {}) {
  return loadConfig({
    VBCDX_FORGEJO_URL: url,
    VBCDX_FORGEJO_WRITES: 'full',
    VBCDX_FORGEJO_TIMEOUT_MS: '5000',
    ...overrides,
  });
}

/** Write a valid credential file (0600 in a fresh 0700 dir) and return its path. */
export function makeCredFile(fields = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'vbcdx-cred-'));
  chmodSync(dir, 0o700);
  const lines = [];
  const f = { VBCDX_AGENTS_ROLE: 'code-agent', VBCDX_AGENTS_USER: 'bot', VBCDX_AGENTS_TOKEN: 'secret-token-value', ...fields };
  for (const [k, v] of Object.entries(f)) {
    if (v === null) continue;
    lines.push(`${k}=${v}`);
  }
  const path = join(dir, 'code-agent.env');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
