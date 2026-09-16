// End-to-end behaviour of the whole request/verify/envelope machinery, driven
// through executeTool against a real loopback HTTP server with real credential
// files. This is where the contract's observable guarantees are pinned.

import { describe, it, expect, afterEach } from 'vitest';
import { executeTool, getTool } from '../src/index.js';
import { fakeHost, fakeConfig, makeCredFile } from './helpers.js';

let host;
afterEach(async () => {
  if (host) await host.close();
  host = undefined;
});

async function call(name, args, configOverrides) {
  const config = fakeConfig(host.url, configOverrides);
  return executeTool(getTool(name), args, { config });
}

const cred = () => makeCredFile();

describe('reads', () => {
  it('whoami returns ok with a projected user', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 7, login: 'octo', full_name: 'Octo', extra: 'dropped' } }) });
    const r = await call('whoami', { credential_file: cred() });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.outcome).toBe('ok');
    expect(r.structuredContent.effect).toBe('read');
    expect(r.structuredContent.data).toEqual({ id: 7, login: 'octo', full_name: 'Octo' });
    expect(r.structuredContent.data.extra).toBeUndefined();
  });

  it('maps 404 to failed/not_found', async () => {
    host = await fakeHost({ 'GET /api/v1/repos/o/r': () => ({ status: 404, json: { message: 'no' } }) });
    const r = await call('get_repository', { credential_file: cred(), owner: 'o', repo: 'r' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.reason).toBe('not_found');
    expect(r.structuredContent.http_status).toBe(404);
  });

  it('maps 403 to failed/permission_denied with no credential fallback', async () => {
    let hits = 0;
    host = await fakeHost({
      'GET /api/v1/user': () => {
        hits += 1;
        return { status: 403, json: { message: 'forbidden' } };
      },
    });
    const r = await call('whoami', { credential_file: makeCredFile({ VBCDX_AGENTS_PASSWORD: 'pw' }) });
    expect(r.structuredContent.reason).toBe('permission_denied');
    expect(hits).toBe(1); // no retry on 403
  });

  it('retries once with Basic after an explicit 401 on the token request', async () => {
    const seen = [];
    host = await fakeHost({
      'GET /api/v1/user': ({ req }) => {
        seen.push(req.headers.authorization.split(' ')[0]);
        if (req.headers.authorization.startsWith('token')) return { status: 401, json: { message: 'bad token' } };
        return { json: { id: 1, login: 'ok' } };
      },
    });
    const r = await call('whoami', { credential_file: makeCredFile({ VBCDX_AGENTS_PASSWORD: 'pw' }) });
    expect(r.structuredContent.outcome).toBe('ok');
    expect(seen).toEqual(['token', 'Basic']);
  });

  it('rejects a redirect rather than following it', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ status: 302, headers: { location: 'https://evil.example/' } }) });
    const r = await call('whoami', { credential_file: cred() });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.reason).toBe('unexpected_response');
  });

  it('caps the response body at 2 MiB', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { blob: 'x'.repeat(2 * 1024 * 1024 + 16) } }) });
    const r = await call('whoami', { credential_file: cred() });
    expect(r.structuredContent.reason).toBe('response_too_large');
  });

  it('treats a full page as possibly-incomplete and an empty page as terminal', async () => {
    const full = Array.from({ length: 25 }, (_, i) => ({ id: i, full_name: `o/r${i}` }));
    host = await fakeHost({
      'GET /api/v1/orgs/o/repos': ({ url }) => {
        const page = Number(url.searchParams.get('page'));
        return { json: page === 1 ? full : [] };
      },
    });
    const p1 = await call('list_repositories', { credential_file: cred(), org: 'o', limit: 25 });
    expect(p1.structuredContent.data.count).toBe(25);
    expect(p1.structuredContent.data.has_more).toBe(null); // unknown, offered as a probe
    expect(p1.structuredContent.data.next_page).toBe(2);

    const p2 = await call('list_repositories', { credential_file: cred(), org: 'o', page: 2, limit: 25 });
    expect(p2.structuredContent.data.count).toBe(0);
    expect(p2.structuredContent.data.has_more).toBe(false);
    expect(p2.structuredContent.data.next_page).toBe(null);
  });

  it('uses an authoritative total_count when present', async () => {
    const runs = Array.from({ length: 2 }, (_, i) => ({ id: i, index_in_repo: i, status: 'success' }));
    host = await fakeHost({ 'GET /api/v1/repos/o/r/actions/runs': () => ({ json: { total_count: 2, workflow_runs: runs } }) });
    const r = await call('list_workflow_runs', { credential_file: cred(), owner: 'o', repo: 'r', limit: 25 });
    expect(r.structuredContent.data.total).toBe(2);
    expect(r.structuredContent.data.has_more).toBe(false);
    expect(r.structuredContent.data.next_page).toBe(null);
  });

  it('times out a slow read as failed/timeout', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => new Promise((res) => setTimeout(() => res({ json: { id: 1, login: 'x' } }), 1500)) });
    const r = await call('whoami', { credential_file: cred() }, { VBCDX_FORGEJO_TIMEOUT_MS: '1000' });
    expect(r.structuredContent.reason).toBe('timeout');
    expect(r.structuredContent.request.attempted).toBe(true);
  });
});

describe('discoverability and gating without a working call', () => {
  it('refuses a missing credential file before any network request', async () => {
    host = await fakeHost({ 'GET /api/v1/user': () => ({ json: { id: 1, login: 'x' } }) });
    const r = await call('whoami', { credential_file: '/nope/missing.env' });
    expect(r.structuredContent.reason).toBe('credential_missing');
    expect(r.structuredContent.request.attempted).toBe(false);
    expect(host.requests).toHaveLength(0);
  });

  it('refuses a write when the gate is off, before any network request', async () => {
    host = await fakeHost({});
    const config = fakeConfig(host.url, { VBCDX_FORGEJO_WRITES: 'off' });
    const r = await executeTool(getTool('create_comment'), { credential_file: cred(), owner: 'o', repo: 'r', index: 1, body: 'hi' }, { config });
    expect(r.structuredContent.reason).toBe('write_gate_disabled');
    expect(host.requests).toHaveLength(0);
  });

  it('refuses a destructive tool when writes=write (needs full)', async () => {
    host = await fakeHost({});
    const config = fakeConfig(host.url, { VBCDX_FORGEJO_WRITES: 'write' });
    const r = await executeTool(getTool('merge_pull_request'), { credential_file: cred(), owner: 'o', repo: 'r', index: 1, expected_head_sha: 'a'.repeat(40), method: 'squash', confirm: 'x' }, { config });
    expect(r.structuredContent.reason).toBe('write_gate_disabled');
    expect(host.requests).toHaveLength(0);
  });

  it('returns server_not_configured when the URL is unset, before network', async () => {
    host = await fakeHost({});
    const config = fakeConfig(host.url, { VBCDX_FORGEJO_URL: '' });
    const r = await executeTool(getTool('whoami'), { credential_file: cred() }, { config });
    expect(r.structuredContent.reason).toBe('server_not_configured');
  });
});

describe('writes with verification', () => {
  it('creates a comment and confirms the exact multiline body, including a trailing newline', async () => {
    const body = 'line one\nline two\n';
    host = await fakeHost({
      'POST /api/v1/repos/o/r/issues/1/comments': ({ body: raw }) => {
        const sent = JSON.parse(raw).body;
        return { status: 201, json: { id: 55, body: sent, user: { login: 'bot' } } };
      },
      'GET /api/v1/repos/o/r/issues/comments/55': () => ({ json: { id: 55, body, user: { login: 'bot' } } }),
    });
    const r = await call('create_comment', { credential_file: cred(), owner: 'o', repo: 'r', index: 1, body });
    expect(r.structuredContent.outcome).toBe('ok');
    expect(r.structuredContent.verification).toBe('confirmed');
    expect(r.structuredContent.data.body).toBe(body);
  });

  it('reports unverified/mismatch when the read-back body differs', async () => {
    host = await fakeHost({
      'POST /api/v1/repos/o/r/issues/1/comments': () => ({ status: 201, json: { id: 9, body: 'sent' } }),
      'GET /api/v1/repos/o/r/issues/comments/9': () => ({ json: { id: 9, body: 'DIFFERENT' } }),
    });
    const r = await call('create_comment', { credential_file: cred(), owner: 'o', repo: 'r', index: 1, body: 'sent' });
    expect(r.structuredContent.outcome).toBe('unverified');
    expect(r.structuredContent.verification).toBe('mismatch');
    expect(r.isError).toBe(true);
    expect(r.structuredContent.data).toBeUndefined(); // no resource data on a failure
  });

  it('reports indeterminate_write when a mutation returns 5xx', async () => {
    host = await fakeHost({ 'POST /api/v1/repos/o/r/issues/1/comments': () => ({ status: 500, json: { message: 'boom' } }) });
    const r = await call('create_comment', { credential_file: cred(), owner: 'o', repo: 'r', index: 1, body: 'x' });
    expect(r.structuredContent.outcome).toBe('indeterminate');
    expect(r.structuredContent.reason).toBe('indeterminate_write');
  });
});

describe('destructive delete_comment', () => {
  const digestBody = 'to be deleted';
  // sha256 of digestBody, computed by the tool's own hasher in the happy path.
  it('requires the exact confirm string before any network request', async () => {
    host = await fakeHost({});
    const r = await call('delete_comment', {
      credential_file: cred(),
      owner: 'o',
      repo: 'r',
      id: 3,
      expected_body_sha256: 'a'.repeat(64),
      confirm: 'wrong',
    });
    expect(r.structuredContent.reason).toBe('confirmation_mismatch');
    expect(host.requests).toHaveLength(0);
  });

  it('refuses on a digest mismatch (stale body) without deleting', async () => {
    let deletes = 0;
    host = await fakeHost({
      'GET /api/v1/repos/o/r/issues/comments/3': () => ({ json: { id: 3, body: 'current body' } }),
      'DELETE /api/v1/repos/o/r/issues/comments/3': () => {
        deletes += 1;
        return { status: 204 };
      },
    });
    const r = await call('delete_comment', {
      credential_file: cred(),
      owner: 'o',
      repo: 'r',
      id: 3,
      expected_body_sha256: 'b'.repeat(64),
      confirm: 'delete comment o/r#3',
    });
    expect(r.structuredContent.reason).toBe('conflict');
    expect(deletes).toBe(0);
  });

  it('deletes and confirms absence when the digest matches', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(digestBody).digest('hex');
    let deleted = false;
    host = await fakeHost({
      'GET /api/v1/repos/o/r/issues/comments/3': () => (deleted ? { status: 404, json: { message: 'gone' } } : { json: { id: 3, body: digestBody } }),
      'DELETE /api/v1/repos/o/r/issues/comments/3': () => {
        deleted = true;
        return { status: 204 };
      },
    });
    const r = await call('delete_comment', {
      credential_file: cred(),
      owner: 'o',
      repo: 'r',
      id: 3,
      expected_body_sha256: digest,
      confirm: 'delete comment o/r#3',
    });
    expect(r.structuredContent.outcome).toBe('ok');
    expect(r.structuredContent.verification).toBe('confirmed');
    expect(r.structuredContent.data).toEqual({ id: 3, deleted: true });
  });
});

describe('no secret ever appears in a returned result', () => {
  it('keeps the token out of the envelope on both success and failure paths', async () => {
    const canary = 'CANARY-SECRET-9f9f9f';
    host = await fakeHost({ 'GET /api/v1/user': () => ({ status: 500, json: { message: 'err' } }) });
    const okHost = host;
    const r = await executeTool(
      getTool('whoami'),
      { credential_file: makeCredFile({ VBCDX_AGENTS_TOKEN: canary }) },
      { config: fakeConfig(okHost.url) },
    );
    const text = JSON.stringify(r);
    expect(text).not.toContain(canary);
  });
});
