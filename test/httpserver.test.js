// Acceptance for the network-served mode (`serve`): drive the real listener with
// a real MCP Streamable HTTP client, proving header-credential auth, that the
// write gate and finite catalogue behave identically to stdio, that discovery
// works without credentials, and — the highest-risk property — that no header
// value ever reaches stdout/stderr on success or failure.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { runHttpServer, httpHealthcheck, authFromHeader, loadHttpOptions, parseAllowedOrigins, originAllowed } from '../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fakeHost, fakeConfig } from './helpers.js';

// A recognisable, obviously-fake token — never a real credential.
const SENTINEL = 'SENTINEL-DO-NOT-LOG-Xy9z0000';

let host;
let srv;
let logs;
const clients = [];

afterEach(async () => {
  while (clients.length) await clients.pop().close().catch(() => {});
  if (srv) await srv.close();
  if (host) await host.close();
  srv = undefined;
  host = undefined;
});

async function startServer(configOverrides, { allowedOrigins } = {}) {
  logs = [];
  const config = fakeConfig(host.url, configOverrides);
  srv = await runHttpServer({
    config,
    http: { port: 0, host: '127.0.0.1', certPath: null, keyPath: null, portError: null, allowedOrigins },
    log: (m) => logs.push(m),
    installSignals: false,
  });
  return srv;
}

async function connect(headers) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  const c = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  clients.push(c);
  await c.connect(transport);
  return c;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenHdr = (t) => ({ Authorization: `token ${t}` });
const basic = (u, p) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}` });

describe('serve — discovery and routing', () => {
  it('lists the same 35 tools without credentials, and drops credential_file from the schema', async () => {
    host = await fakeHost({});
    await startServer();
    const c = await connect(null);
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(35);
    const whoami = tools.find((t) => t.name === 'whoami');
    expect(whoami.inputSchema.properties.credential_file).toBeUndefined();
    expect((whoami.inputSchema.required || [])).not.toContain('credential_file');
    // Effect annotations still ride along.
    expect(whoami.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'delete_comment').annotations.destructiveHint).toBe(true);
  });

  it('serves /healthz with 200 and no credentials', async () => {
    host = await fakeHost({});
    await startServer();
    const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.tools).toBe(35);
  });

  it('rejects GET /mcp with 405 and an unknown path with 404', async () => {
    host = await fakeHost({});
    await startServer();
    const get = await fetch(`http://127.0.0.1:${srv.port}/mcp`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toContain('POST');
    const nope = await fetch(`http://127.0.0.1:${srv.port}/nope`);
    expect(nope.status).toBe(404);
  });
});

describe('serve — header credentials', () => {
  it('authenticates a Bearer PAT, forwarding it upstream as Forgejo token scheme', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 7, login: 'octo' } }) });
    await startServer({ VBCDX_FORGEJO_WRITES: 'off' });
    const c = await connect(bearer(SENTINEL));
    const res = await c.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError).toBe(false);
    expect(res.structuredContent.outcome).toBe('ok');
    expect(res.structuredContent.data.login).toBe('octo');
    expect(host.requests.at(-1).headers.authorization).toBe(`token ${SENTINEL}`);
  });

  it('accepts the token scheme too, forwarding it verbatim as token', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 7, login: 'octo' } }) });
    await startServer({ VBCDX_FORGEJO_WRITES: 'off' });
    const c = await connect(tokenHdr(SENTINEL));
    const res = await c.callTool({ name: 'whoami', arguments: {} });
    expect(res.structuredContent.outcome).toBe('ok');
    expect(host.requests.at(-1).headers.authorization).toBe(`token ${SENTINEL}`);
  });

  it('authenticates a Basic user/password, forwarding it verbatim', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 7, login: 'octo' } }) });
    await startServer({ VBCDX_FORGEJO_WRITES: 'off' });
    const c = await connect(basic('bot', SENTINEL));
    const res = await c.callTool({ name: 'whoami', arguments: {} });
    expect(res.structuredContent.outcome).toBe('ok');
    const expected = `Basic ${Buffer.from(`bot:${SENTINEL}`, 'utf8').toString('base64')}`;
    expect(host.requests.at(-1).headers.authorization).toBe(expected);
  });

  it('does NOT retry with Basic after a 401 — a single header carries one credential', async () => {
    let hits = 0;
    host = await fakeHost({
      'GET /api/v1/user': () => {
        hits += 1;
        return { status: 401, json: { message: 'bad token' } };
      },
    });
    await startServer({ VBCDX_FORGEJO_WRITES: 'off' });
    const c = await connect(bearer(SENTINEL));
    const res = await c.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.reason).toBe('credential_rejected');
    expect(hits).toBe(1); // no second attempt
  });

  it('returns a redacted, actionable error (not a crash) when a call has no credentials', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 1, login: 'x' } }) });
    await startServer();
    const c = await connect(null);
    const res = await c.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.reason).toBe('credential_missing');
    expect(res.structuredContent.message).toMatch(/Authorization header/i);
  });

  it('returns a redacted error for a malformed Authorization header', async () => {
    host = await fakeHost({});
    await startServer();
    const c = await connect({ Authorization: 'Weird xyz' });
    const res = await c.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.reason).toBe('credential_malformed');
  });
});

describe('serve — write and destructive gating parity', () => {
  it('refuses a write when VBCDX_FORGEJO_WRITES=off, before any network call', async () => {
    let hits = 0;
    host = await fakeHost({ 'POST /api/v1/repos/o/r/issues/1/comments': () => { hits += 1; return { json: { id: 1 } }; } });
    await startServer({ VBCDX_FORGEJO_WRITES: 'off' });
    const c = await connect(bearer(SENTINEL));
    const res = await c.callTool({ name: 'create_comment', arguments: { owner: 'o', repo: 'r', index: 1, body: 'hi' } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.reason).toBe('write_gate_disabled');
    expect(hits).toBe(0); // never reached the network
  });

  it('keeps a destructive tool unreachable at writes=write even over HTTP', async () => {
    let hits = 0;
    host = await fakeHost({ 'GET /api/v1/repos/o/r/issues/comments/5': () => { hits += 1; return { json: { id: 5, body: 'x' } }; } });
    await startServer({ VBCDX_FORGEJO_WRITES: 'write' }); // write, NOT full
    const c = await connect(bearer(SENTINEL));
    const res = await c.callTool({
      name: 'delete_comment',
      arguments: { owner: 'o', repo: 'r', id: 5, expected_body_sha256: '0'.repeat(64), confirm: 'delete comment o/r#5' },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.reason).toBe('write_gate_disabled');
    expect(hits).toBe(0); // gate fired before the preflight read
  });
});

describe('serve — no credential value ever reaches stdout/stderr', () => {
  it('leaks nothing on the success path or the failure path', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      host = await fakeHost({
        // First call (success), later calls (500 failure) — same sentinel header.
        'GET /api/v1/user': ({ count }) => (count === 1 ? { json: { id: 7, login: 'octo' } } : { status: 500, json: { message: 'boom' } }),
      });
      // Default log writes to process.stderr, which we are also capturing.
      srv = await runHttpServer({
        config: fakeConfig(host.url, { VBCDX_FORGEJO_WRITES: 'off' }),
        http: { port: 0, host: '127.0.0.1', certPath: null, keyPath: null, portError: null },
        installSignals: false,
      });

      const ok = await connect(bearer(SENTINEL));
      const okRes = await ok.callTool({ name: 'whoami', arguments: {} });
      expect(okRes.structuredContent.outcome).toBe('ok');

      const bad = await connect(bearer(SENTINEL));
      const badRes = await bad.callTool({ name: 'whoami', arguments: {} });
      expect(badRes.isError).toBe(true);

      const captured = [...stderrSpy.mock.calls, ...stdoutSpy.mock.calls].map((c) => String(c[0])).join('');
      expect(captured).not.toContain(SENTINEL);
      // The sentinel must not leak into the returned envelopes either.
      expect(JSON.stringify(okRes)).not.toContain(SENTINEL);
      expect(JSON.stringify(badRes)).not.toContain(SENTINEL);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});

// The MCP transport spec's MUST on Origin (DNS
// rebinding). Raw fetch, because the SDK client never sends an Origin.
describe('serve — Origin validation', () => {
  const whoamiCall = (origin, auth = bearer(SENTINEL)) => fetch(`http://127.0.0.1:${srv.port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...auth,
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });

  it('refuses any request carrying an Origin with 403, before any Forgejo request, and never echoes it', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 7, login: 'octo' } }) });
    await startServer({ VBCDX_FORGEJO_WRITES: 'off' });
    for (const origin of ['http://evil.example', 'http://127.0.0.1:8080', 'null', '']) {
      const r = await whoamiCall(origin);
      expect(r.status, origin).toBe(403);
      const text = await r.text();
      expect(text).toMatch(/Origin not allowed/);
      if (origin.includes('://')) expect(text).not.toContain(origin);
    }
    const health = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { origin: 'http://evil.example' } });
    expect(health.status).toBe(403);
    expect(host.requests).toHaveLength(0);
  });

  it('serves a request with no Origin, and one from an allowed origin (compared normalised)', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 7, login: 'octo' } }) });
    await startServer({ VBCDX_FORGEJO_WRITES: 'off' }, { allowedOrigins: ['https://chat.example.com'] });
    expect((await whoamiCall(undefined)).status).toBe(200);
    expect((await whoamiCall('https://CHAT.example.com:443')).status).toBe(200);
    expect((await whoamiCall('https://chat.example.com.evil.example')).status).toBe(403);
    expect((await whoamiCall('http://chat.example.com')).status).toBe(403);
    expect(host.requests).toHaveLength(2);
  });

  it('parses VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS strictly and refuses to start on a bad entry', async () => {
    expect(parseAllowedOrigins(undefined)).toEqual({ allowedOrigins: [], originsError: null });
    expect(parseAllowedOrigins(' https://a.example , http://b.example:8080 ,').allowedOrigins)
      .toEqual(['https://a.example', 'http://b.example:8080']);
    for (const bad of ['a.example', 'null', 'ftp://a.example', 'https://a.example/path', 'https://u:p@a.example', 'https://a.example?x=1', 'https://*.example.com', 'http://*:8080']) {
      expect(parseAllowedOrigins(bad).originsError, bad).toMatch(/ALLOWED_ORIGINS/);
    }
    expect(loadHttpOptions({ VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS: 'https://a.example' }).allowedOrigins).toEqual(['https://a.example']);
    expect(originAllowed(undefined, [])).toBe(true);
    expect(originAllowed('https://a.example', [])).toBe(false);
    host = await fakeHost({});
    await expect(runHttpServer({
      config: fakeConfig(host.url),
      http: { port: 0, host: '127.0.0.1', certPath: null, keyPath: null, portError: null, originsError: 'VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS bad' },
      log: () => {},
      installSignals: false,
    })).rejects.toThrow(/ALLOWED_ORIGINS/);
  });
});

describe('authFromHeader — unit', () => {
  it('maps Bearer/token to a single upstream token attempt', () => {
    for (const h of [`Bearer ${SENTINEL}`, `token ${SENTINEL}`, `TOKEN ${SENTINEL}`]) {
      const { attempts, state } = authFromHeader(h);
      expect(attempts).toEqual([{ header: `token ${SENTINEL}`, kind: 'token' }]);
      expect(state).toEqual({});
    }
  });

  it('maps Basic to a single Basic attempt, forwarded verbatim', () => {
    const b64 = Buffer.from(`bot:${SENTINEL}`, 'utf8').toString('base64');
    const { attempts } = authFromHeader(`Basic ${b64}`);
    expect(attempts).toEqual([{ header: `Basic ${b64}`, kind: 'basic' }]);
  });

  it('never echoes any part of the header value in an error', () => {
    const cases = ['', undefined, `Bearer `, `Weird ${SENTINEL}`, `Basic ${Buffer.from('no-colon').toString('base64')}`, SENTINEL];
    for (const h of cases) {
      try {
        authFromHeader(h);
        // A bare value with no scheme must throw, not pass.
        expect(h).not.toBe(SENTINEL);
      } catch (e) {
        expect(e.outcome).toBe('refused');
        expect(['credential_missing', 'credential_malformed']).toContain(e.reason);
        expect(e.message).not.toContain(SENTINEL);
      }
    }
  });
});

describe('httpHealthcheck', () => {
  it('is true against a live server and false when nothing is listening', async () => {
    host = await fakeHost({});
    await startServer();
    const env = { VBCDX_FORGEJO_HTTP_PORT: String(srv.port) };
    expect(await httpHealthcheck({ env })).toBe(true);
    // Unexpanded TLS references: serve would refuse to start, so the probe reports unhealthy
    // rather than guessing a scheme.
    expect(await httpHealthcheck({ env: { ...env, VBCDX_FORGEJO_TLS_CERT: '${VBCDX_FORGEJO_TLS_CERT}', VBCDX_FORGEJO_TLS_KEY: '${VBCDX_FORGEJO_TLS_KEY}' } })).toBe(false);
    await srv.close();
    srv = undefined;
    expect(await httpHealthcheck({ env })).toBe(false);
  });
});

describe('network options and an unexpanded ${VAR}', () => {
  const ref = (k) => '${' + k + '}';

  it('port and origins fall back to their safe defaults', () => {
    const o = loadHttpOptions({ VBCDX_FORGEJO_HTTP_PORT: ref('VBCDX_FORGEJO_HTTP_PORT'), VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS: ref('VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS') });
    expect(o).toEqual({ port: 8080, host: '127.0.0.1', certPath: null, keyPath: null, portError: null, allowedOrigins: [], originsError: null, unexpandedError: null });
  });

  it('TLS and the bind host fail closed: serve refuses to start and names the settings', async () => {
    for (const keys of [['VBCDX_FORGEJO_TLS_CERT'], ['VBCDX_FORGEJO_TLS_KEY'], ['VBCDX_FORGEJO_HTTP_HOST'], ['VBCDX_FORGEJO_TLS_CERT', 'VBCDX_FORGEJO_TLS_KEY']]) {
      const o = loadHttpOptions(Object.fromEntries(keys.map((k) => [k, ` ${ref(k)} `])));
      expect(o.unexpandedError, keys.join()).toBe(`${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} an unexpanded \${...} reference; set ${keys.length === 1 ? 'it' : 'them'} to a real value or leave ${keys.length === 1 ? 'it' : 'them'} unset.`);
      await expect(runHttpServer({ config: fakeConfig('http://127.0.0.1:1'), http: o, log: () => {}, installSignals: false })).rejects.toThrow(/unexpanded/);
    }
    // A real value is still used as given.
    expect(loadHttpOptions({ VBCDX_FORGEJO_HTTP_HOST: '127.0.0.1' }).unexpandedError).toBeNull();
  });
});
