// Protocol-level acceptance: spawn the actual bin as an MCP server and drive it
// through a real MCP client over stdio — initialize, tools/list, tools/call —
// plus the CLI exit-code contract.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeHost, makeCredFile } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/vbcdx-forgejo.js', import.meta.url));

let host;
let client;
afterEach(async () => {
  if (client) await client.close().catch(() => {});
  if (host) await host.close();
  client = undefined;
  host = undefined;
});

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    env: { ...getDefaultEnvironment(), ...env },
    stderr: 'ignore',
  });
  const c = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await c.connect(transport);
  return c;
}

describe('MCP server over stdio', () => {
  it('lists 33 tools with schemas and effect annotations, even without configuration', async () => {
    client = await connect({}); // no VBCDX_FORGEJO_URL
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(33);
    const whoami = tools.find((t) => t.name === 'whoami');
    expect(whoami.inputSchema).toBeTruthy();
    expect(whoami.outputSchema).toBeTruthy();
    expect(whoami.annotations.readOnlyHint).toBe(true);
    const del = tools.find((t) => t.name === 'delete_comment');
    expect(del.annotations.destructiveHint).toBe(true);
  });

  it('calls whoami end-to-end against a fake host and returns the ok envelope', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 42, login: 'e2e' } }) });
    client = await connect({ VBCDX_FORGEJO_URL: host.url, VBCDX_FORGEJO_WRITES: 'off', VBCDX_FORGEJO_TIMEOUT_MS: '5000' });
    const res = await client.callTool({ name: 'whoami', arguments: { credential_file: makeCredFile() } });
    expect(res.isError).toBe(false);
    expect(res.structuredContent.outcome).toBe('ok');
    expect(res.structuredContent.data.login).toBe('e2e');
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0].type).toBe('text');
  });

  it('returns an actionable tool error, not a crash, when credentials are missing', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 1, login: 'x' } }) });
    client = await connect({ VBCDX_FORGEJO_URL: host.url });
    const res = await client.callTool({ name: 'whoami', arguments: { credential_file: '/nope/x.env' } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.reason).toBe('credential_missing');
  });
});

describe('CLI exit-code contract', () => {
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

  it('--version prints a version and exits 0', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help exits 0 and mentions the commands', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('manifest');
    expect(r.stdout).toContain('mcp');
  });

  it('manifest prints valid JSON and exits 0', () => {
    const r = run(['manifest']);
    expect(r.status).toBe(0);
    const m = JSON.parse(r.stdout);
    expect(m.tools).toHaveLength(33);
  });

  it('an unknown command exits 2', () => {
    expect(run(['frobnicate']).status).toBe(2);
  });

  it('an argument to manifest exits 2', () => {
    expect(run(['manifest', 'extra']).status).toBe(2);
  });
});
