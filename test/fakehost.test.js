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

describe('create_repository', () => {
  const repoJson = (over = {}) => ({ id: 7, name: 'svc', full_name: 'org/svc', owner: { login: 'org' }, private: true, description: 'd', default_branch: 'main', html_url: 'http://x/org/svc', ...over });

  it('creates an org repository with explicit visibility and confirms it by reading it back', async () => {
    let sent;
    host = await fakeHost({
      'POST /api/v1/orgs/org/repos': ({ body: raw }) => { sent = JSON.parse(raw); return { status: 201, json: repoJson() }; },
      'GET /api/v1/repos/org/svc': () => ({ json: repoJson() }),
    });
    const r = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true, description: 'd', auto_init: true, default_branch: 'main' });
    expect(sent).toEqual({ name: 'svc', private: true, description: 'd', auto_init: true, default_branch: 'main' });
    expect(r.structuredContent.outcome).toBe('ok');
    expect(r.structuredContent.verification).toBe('confirmed');
    expect(r.structuredContent.data).toEqual({ id: 7, full_name: 'org/svc', description: 'd', private: true, default_branch: 'main', html_url: 'http://x/org/svc' });
  });

  it('reports unverified/mismatch when the repository came back with other visibility', async () => {
    host = await fakeHost({
      'POST /api/v1/orgs/org/repos': () => ({ status: 201, json: repoJson({ private: false }) }),
      'GET /api/v1/repos/org/svc': () => ({ json: repoJson({ private: false }) }),
    });
    const r = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true });
    expect(r.structuredContent.outcome).toBe('unverified');
    expect(r.structuredContent.verification).toBe('mismatch');
    expect(r.structuredContent.message).toMatch(/visibility/);
    expect(r.isError).toBe(true);
  });

  // Each compared field on its own: the POST succeeds, the read-back differs in one field only.
  for (const [field, over, args, word] of [
    ['description', { description: 'other' }, { description: 'd' }, /description/],
    ['default branch', { default_branch: 'master' }, { auto_init: true, default_branch: 'main' }, /default branch/],
    ['name', { name: 'svc2', full_name: 'org/svc2' }, {}, /name/],
  ]) {
    it(`reports unverified/mismatch when the read-back ${field} differs`, async () => {
      host = await fakeHost({
        'POST /api/v1/orgs/org/repos': () => ({ status: 201, json: repoJson() }),
        'GET /api/v1/repos/org/svc': () => ({ json: repoJson(over) }),
      });
      const r = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true, ...args });
      expect(r.structuredContent.outcome).toBe('unverified');
      expect(r.structuredContent.verification).toBe('mismatch');
      expect(r.structuredContent.message).toMatch(word);
    });
  }

  // Forgejo returns the canonical case (VBCDX) while callers often type
  // the slug (vbcdx); both compares must stay case-insensitive.
  for (const [field, over] of [
    ['owner', { owner: { login: 'Org' }, full_name: 'Org/svc' }],
    ['name', { name: 'Svc', full_name: 'org/Svc' }],
  ]) {
    it(`confirms when the read-back ${field} differs only in case`, async () => {
      host = await fakeHost({
        'POST /api/v1/orgs/org/repos': () => ({ status: 201, json: repoJson(over) }),
        'GET /api/v1/repos/org/svc': () => ({ json: repoJson(over) }),
      });
      const r = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true });
      expect(r.structuredContent.outcome).toBe('ok');
      expect(r.structuredContent.verification).toBe('confirmed');
    });
  }

  it('verifies at the requested org, not at the owner the POST response names', async () => {
    const reads = [];
    host = await fakeHost({
      'POST /api/v1/orgs/org/repos': () => ({ status: 201, json: repoJson({ owner: { login: 'other' }, full_name: 'other/svc' }) }),
      'GET /api/v1/repos/other/svc': () => { reads.push('other'); return { json: repoJson({ owner: { login: 'other' }, full_name: 'other/svc' }) }; },
      'GET /api/v1/repos/org/svc': () => { reads.push('org'); return { json: repoJson({ owner: { login: 'other' }, full_name: 'other/svc' }) }; },
    });
    const r = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true });
    expect(reads).toEqual(['org']);
    expect(r.structuredContent.outcome).toBe('unverified');
    expect(r.structuredContent.verification).toBe('mismatch');
    expect(r.structuredContent.message).toMatch(/owner/);
  });

  it('refuses default_branch without auto_init, before any request', async () => {
    host = await fakeHost({ 'POST /api/v1/orgs/org/repos': () => ({ status: 201, json: repoJson() }) });
    const r = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true, default_branch: 'trunk' });
    expect(r.structuredContent.reason).toBe('validation_failed');
    expect(host.requests).toHaveLength(0);
  });

  it('reports unverified when the created repository cannot be read back', async () => {
    host = await fakeHost({ 'POST /api/v1/orgs/org/repos': () => ({ status: 201, json: repoJson() }) });
    const r = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true });
    expect(r.structuredContent.outcome).toBe('unverified');
    expect(r.structuredContent.verification).toBe('unavailable');
  });

  it('maps an existing name (409) to failed/conflict and a missing scope (403) to permission_denied', async () => {
    host = await fakeHost({ 'POST /api/v1/orgs/org/repos': () => ({ status: 409, json: { message: 'exists' } }) });
    const exists = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true });
    expect(exists.structuredContent.reason).toBe('conflict');
    await host.close();
    host = await fakeHost({ 'POST /api/v1/orgs/org/repos': () => ({ status: 403, json: { message: 'token does not have at least one of required scope(s): [write:organization]' } }) });
    const scope = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true });
    expect(scope.structuredContent.reason).toBe('permission_denied');
  });

  it('refuses before any network request: gate off, missing visibility, and unsafe names', async () => {
    host = await fakeHost({ 'POST /api/v1/orgs/org/repos': () => ({ status: 201, json: repoJson() }) });
    const gated = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc', private: true }, { VBCDX_FORGEJO_WRITES: 'off' });
    expect(gated.structuredContent.reason).toBe('write_gate_disabled');
    const noVis = await call('create_repository', { credential_file: cred(), org: 'org', name: 'svc' });
    expect(noVis.structuredContent.reason).toBe('validation_failed');
    for (const name of ['.', '..', '.hidden', 'a/b', 'a b', '']) {
      const bad = await call('create_repository', { credential_file: cred(), org: 'org', name, private: true });
      expect(bad.structuredContent.reason, name).toBe('validation_failed');
    }
    expect(host.requests).toHaveLength(0);
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

describe('list_comments paging', () => {
  const ROUTE = 'GET /api/v1/repos/o/r/issues/1/comments';
  const comments = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, body: `c${i}`, user: { login: 'u' } }));
  const ids = (r) => r.structuredContent.data.items.map((c) => c.id);
  const list = (args) => call('list_comments', { credential_file: cred(), owner: 'o', repo: 'r', index: 1, ...args });

  // Forgejo's issue-comments route has no pagination: every call returns everything.
  const unpaged = (all) => ({ [ROUTE]: () => ({ json: all }) });
  // A paged route with a per-page clamp (MAX_RESPONSE_ITEMS may be below the requested limit).
  const paged = (all, clamp = 50) => ({
    [ROUTE]: ({ url }) => {
      const page = Number(url.searchParams.get('page'));
      const size = Math.min(Number(url.searchParams.get('limit')), clamp);
      return { json: all.slice((page - 1) * size, page * size) };
    },
  });

  it('an unpaged route with 4 comments returns them once, not truncated', async () => {
    host = await fakeHost(unpaged(comments(4)));
    const r = await list({});
    expect(r.structuredContent.outcome).toBe('ok');
    expect(ids(r)).toEqual([1000, 1001, 1002, 1003]);
    expect(r.structuredContent.data.truncated).toBe(false);
    expect(r.structuredContent.data.total).toBe(4);
    expect(r.structuredContent.data.next_offset).toBe(null);
    expect(host.countFor(ROUTE)).toBe(2); // page 2 repeats page 1 → end
  });

  it('an unpaged route with 120 comments pages locally without duplicates', async () => {
    host = await fakeHost(unpaged(comments(120)));
    const first = await list({ limit: 50 });
    expect(ids(first)).toEqual(comments(120).slice(0, 50).map((c) => c.id));
    expect(first.structuredContent.data.truncated).toBe(true);
    expect(first.structuredContent.data.next_offset).toBe(50);
    const last = await list({ offset: 100, limit: 50 });
    expect(ids(last)).toEqual(comments(120).slice(100).map((c) => c.id));
    expect(last.structuredContent.data.truncated).toBe(false);
    expect(last.structuredContent.data.total).toBe(120);
  });

  it('a paged route is read to its empty page, unchanged', async () => {
    host = await fakeHost(paged(comments(60)));
    const r = await list({ offset: 50, limit: 50 });
    expect(ids(r)).toEqual(comments(60).slice(50).map((c) => c.id));
    expect(r.structuredContent.data.total).toBe(60);
    expect(r.structuredContent.data.truncated).toBe(false);
    expect(host.countFor(ROUTE)).toBe(3); // 50, 10, then the empty page
  });

  it('a short page from a clamped host is not taken as the end', async () => {
    host = await fakeHost(paged(comments(70), 30));
    const r = await list({ limit: 50 });
    expect(ids(r)).toEqual(comments(70).slice(0, 50).map((c) => c.id));
    expect(r.structuredContent.data.truncated).toBe(true);
  });

  it('identical id-less items never end a listing: no unprovable total', async () => {
    host = await fakeHost(unpaged([{ body: 'x' }, { body: 'x' }, { body: 'x' }, { body: 'x' }]));
    const r = await list({ limit: 10 });
    expect(r.structuredContent.data.items).toHaveLength(10);
    expect(r.structuredContent.data.truncated).toBe(true);
    expect(r.structuredContent.data.total).toBeUndefined();
  });

  it('id-less items on a paged route are all kept and end on the empty page', async () => {
    const idless = [{ body: 'a' }, { body: 'a' }, { body: 'b' }];
    host = await fakeHost({
      [ROUTE]: ({ url }) => ({ json: Number(url.searchParams.get('page')) === 1 ? idless : [] }),
    });
    const r = await list({});
    expect(r.structuredContent.data.items.map((c) => c.body)).toEqual(['a', 'a', 'b']);
    expect(r.structuredContent.data.total).toBe(3);
    expect(r.structuredContent.data.truncated).toBe(false);
  });

  it('id 0 is an id (de-duplicated, ends an unpaged listing); id null is not', async () => {
    host = await fakeHost(unpaged([{ id: 0, body: 'zero' }, { id: 1, body: 'one' }]));
    const zero = await list({});
    expect(ids(zero)).toEqual([0, 1]);
    expect(zero.structuredContent.data.total).toBe(2);
    await host.close();
    host = await fakeHost(unpaged([{ id: null, body: 'n' }]));
    const nul = await list({ limit: 3 });
    expect(nul.structuredContent.data.items).toHaveLength(3);
    expect(nul.structuredContent.data.truncated).toBe(true);
  });

  it('overlap between pages (an insert between reads) is de-duplicated', async () => {
    const all = comments(55);
    host = await fakeHost({
      [ROUTE]: ({ url }) => {
        const page = Number(url.searchParams.get('page'));
        if (page === 1) return { json: all.slice(0, 50) };
        if (page === 2) return { json: all.slice(49, 55) }; // repeats item 49
        return { json: [] };
      },
    });
    const r = await list({ offset: 45, limit: 50 });
    expect(ids(r)).toEqual(all.slice(45).map((c) => c.id));
    expect(r.structuredContent.data.total).toBe(55);
  });
});

describe('list_reviews filters and body cap', () => {
  const ROUTE = 'GET /api/v1/repos/o/r/pulls/7/reviews';
  const SHA_A = '7b216de1f2a3b4c5d6e7f8091a2b3c4d5e6f7081'; // 40 hex
  const SHA_B = 'cafebabe1f2a3b4c5d6e7f8091a2b3c4d5e6f7081'; // 40 hex
  const review = (over = {}) => ({ id: 11, state: 'COMMENT', body: 'b', commit_id: SHA_A, user: { login: 'u' }, ...over });
  const list = (args) => call('list_reviews', { credential_file: cred(), owner: 'o', repo: 'r', index: 7, ...args });
  const items = (r) => r.structuredContent.data.items;
  const total = (r) => r.structuredContent.data.total;

  // A route that honours page/limit (clamped at 50 by the toolkit's page size).
  const pagedRoute = (all, totalCount) => ({
    [ROUTE]: ({ url }) => {
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('limit'));
      const headers = totalCount === undefined ? {} : { 'x-total-count': String(totalCount) };
      return { json: all.slice((page - 1) * size, page * size), headers };
    },
  });

  // ---- commit_id filter ----

  it('commit_id finds a match on page 2, where a first-page-only filter would miss it', async () => {
    const all = Array.from({ length: 60 }, (_, i) => review({ id: 100 + i, commit_id: SHA_B }));
    all[55] = review({ id: 155, commit_id: SHA_A });
    host = await fakeHost(pagedRoute(all, 60));
    const r = await list({ commit_id: SHA_A.slice(0, 7) });
    expect(r.structuredContent.outcome).toBe('ok');
    expect(items(r).map((x) => x.id)).toEqual([155]);
    expect(items(r)[0].commit_id).toBe(SHA_A);
    expect(total(r)).toBe(1);
    expect(r.structuredContent.data.truncated).toBe(false);
    expect(host.countFor(ROUTE)).toBe(3); // reads page 1, page 2, then the empty page
  });

  it('commit_id accepts a full SHA and a 7-char prefix, and both reviews sharing a prefix', async () => {
    const twin = `7b216de${'c'.repeat(33)}`; // same 7-char prefix, different SHA
    host = await fakeHost({ [ROUTE]: () => ({ json: [review({ id: 1, commit_id: SHA_A }), review({ id: 2, commit_id: twin }), review({ id: 3, commit_id: SHA_B })] }) });
    const exact = await list({ commit_id: SHA_A });
    expect(items(exact).map((x) => x.id)).toEqual([1]);
    const prefixed = await list({ commit_id: '7b216de' });
    expect(items(prefixed).map((x) => x.id)).toEqual([1, 2]);
    expect(total(prefixed)).toBe(2);
  });

  it('refuses a commit_id prefix shorter than 7 characters, before any request', async () => {
    host = await fakeHost({});
    const r = await list({ commit_id: SHA_A.slice(0, 6) });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.reason).toBe('validation_failed');
    expect(host.requests).toHaveLength(0);
  });

  // ---- state filter ----

  it('state filter returns only the reviews in that state', async () => {
    const all = [
      review({ id: 1, state: 'APPROVED' }),
      review({ id: 2, state: 'REQUEST_CHANGES' }),
      review({ id: 3, state: 'COMMENT', commit_id: SHA_B }),
    ];
    host = await fakeHost({ [ROUTE]: () => ({ json: all }) });
    const r = await list({ state: 'REQUEST_CHANGES' });
    expect(items(r).map((x) => x.id)).toEqual([2]);
    expect(total(r)).toBe(1);
  });

  it('commit_id and state filters combine (AND, not OR)', async () => {
    const all = [
      review({ id: 1, state: 'APPROVED', commit_id: SHA_A }),
      review({ id: 2, state: 'APPROVED', commit_id: SHA_B }),
      review({ id: 3, state: 'COMMENT', commit_id: SHA_A }),
    ];
    host = await fakeHost({ [ROUTE]: () => ({ json: all }) });
    const r = await list({ commit_id: SHA_A.slice(0, 7), state: 'APPROVED' });
    expect(items(r).map((x) => x.id)).toEqual([1]);
  });

  it('refuses an unknown state before any request', async () => {
    host = await fakeHost({});
    const r = await list({ state: 'APPROVE' });
    expect(r.structuredContent.reason).toBe('validation_failed');
    expect(host.requests).toHaveLength(0);
  });

  it('keeps the stale and dismissed flags through a commit_id filter', async () => {
    const all = [
      review({ id: 1, state: 'APPROVED', commit_id: SHA_A, stale: true, dismissed: true }),
      review({ id: 2, state: 'APPROVED', commit_id: SHA_B }),
    ];
    host = await fakeHost({ [ROUTE]: () => ({ json: all }) });
    const r = await list({ commit_id: SHA_A.slice(0, 7) });
    expect(items(r)).toHaveLength(1);
    expect(items(r)[0].stale).toBe(true);
    expect(items(r)[0].dismissed).toBe(true);
  });

  it('reports truncated when a filtered scan stops at the read bound before the end of the list', async () => {
    // 1001 reviews: the bounded scan stops after 1000 (20 pages of 50) without
    // reaching an empty page, so it never saw review 1000 and must say so even
    // though the one match it returns has a short body.
    const all = Array.from({ length: 1001 }, (_, i) => review({ id: i, commit_id: SHA_B }));
    all[990] = review({ id: 990, commit_id: SHA_A });
    host = await fakeHost(pagedRoute(all, 1001));
    const r = await list({ commit_id: SHA_A.slice(0, 7) });
    expect(r.structuredContent.outcome).toBe('ok');
    expect(items(r).map((x) => x.id)).toEqual([990]);
    expect(items(r)[0].body_truncated).toBe(false);
    expect(r.structuredContent.data.truncated).toBe(true);
    expect(host.countFor(ROUTE)).toBe(20);
  });

  it('with a filter, page and limit window the filtered list locally', async () => {
    const all = Array.from({ length: 60 }, (_, i) => review({ id: i, commit_id: i % 2 === 1 ? SHA_A : SHA_B }));
    host = await fakeHost(pagedRoute(all, 60));
    const r = await list({ commit_id: SHA_A.slice(0, 7), page: 2, limit: 10 });
    expect(items(r).map((x) => x.id)).toEqual([21, 23, 25, 27, 29, 31, 33, 35, 37, 39]);
    expect(total(r)).toBe(30);
    expect(r.structuredContent.data.has_more).toBe(true);
    expect(r.structuredContent.data.next_page).toBe(3);
  });

  // ---- body cap ----

  it('caps a 10k body at body_max_chars=2000 and flags the item and the envelope', async () => {
    const body = 'x'.repeat(10000);
    host = await fakeHost({ [ROUTE]: () => ({ json: [review({ id: 1, body })] }) });
    const r = await list({ body_max_chars: 2000 });
    const item = items(r)[0];
    expect(item.body).toHaveLength(2000);
    expect(item.body_truncated).toBe(true);
    expect(item.body_length).toBe(10000);
    expect(r.structuredContent.data.truncated).toBe(true);
  });

  it('defaults to a 2000-character cap when body_max_chars is omitted', async () => {
    host = await fakeHost({ [ROUTE]: () => ({ json: [review({ id: 1, body: 'y'.repeat(5000) })] }) });
    const r = await list({});
    const item = items(r)[0];
    expect(item.body).toHaveLength(2000);
    expect(item.body_truncated).toBe(true);
    expect(item.body_length).toBe(5000);
    expect(r.structuredContent.data.truncated).toBe(true);
  });

  it('leaves a body under the cap intact and reports truncated false', async () => {
    host = await fakeHost({ [ROUTE]: () => ({ json: [review({ id: 1, body: 'short' })] }) });
    const r = await list({});
    const item = items(r)[0];
    expect(item.body).toBe('short');
    expect(item.body_truncated).toBe(false);
    expect(item.body_length).toBe(5);
    expect(r.structuredContent.data.truncated).toBe(false);
  });

  it('leaves a body exactly at the cap intact and not truncated', async () => {
    host = await fakeHost({ [ROUTE]: () => ({ json: [review({ id: 1, body: 'q'.repeat(2000) })] }) });
    const r = await list({ body_max_chars: 2000 });
    const item = items(r)[0];
    expect(item.body).toHaveLength(2000);
    expect(item.body_truncated).toBe(false);
    expect(item.body_length).toBe(2000);
    expect(r.structuredContent.data.truncated).toBe(false);
  });

  it('reports the envelope truncated when any body on the page was cut', async () => {
    const all = [review({ id: 1, body: 'short' }), review({ id: 2, body: 'z'.repeat(5000) })];
    host = await fakeHost({ [ROUTE]: () => ({ json: all }) });
    const r = await list({ body_max_chars: 2000 });
    expect(items(r).map((x) => x.body_truncated)).toEqual([false, true]);
    expect(r.structuredContent.data.truncated).toBe(true);
  });

  it('cuts on a character boundary, never inside a multi-byte sequence or a surrogate pair', async () => {
    const body = 'a—😀✓b'; // 5 code points, 6 UTF-16 code units
    host = await fakeHost({ [ROUTE]: () => ({ json: [review({ id: 1, body })] }) });
    const r = await list({ body_max_chars: 4 });
    const item = items(r)[0];
    expect(item.body).toBe('a—😀✓');
    expect([...item.body]).toHaveLength(4);
    expect(item.body_length).toBe(5);
    expect(item.body_truncated).toBe(true);
    // A cut through a UTF-8 sequence would decode back as U+FFFD.
    expect(Buffer.from(item.body, 'utf8').toString('utf8')).toBe(item.body);
    expect(item.body).not.toContain('\ufffd');
  });

  // ---- unfiltered paging is unchanged ----

  it('without a filter, still reads exactly one upstream page (no full scan)', async () => {
    const all = Array.from({ length: 60 }, (_, i) => review({ id: i }));
    host = await fakeHost(pagedRoute(all, 60));
    const r = await list({ page: 2, limit: 25 });
    expect(items(r).map((x) => x.id)).toEqual(Array.from({ length: 25 }, (_, i) => 25 + i));
    expect(r.structuredContent.data.page).toBe(2);
    expect(total(r)).toBe(60);
    expect(r.structuredContent.data.next_page).toBe(3);
    expect(r.structuredContent.data.truncated).toBe(false);
    expect(host.countFor(ROUTE)).toBe(1);
  });
});

describe('get_review', () => {
  const ROUTE = 'GET /api/v1/repos/o/r/pulls/7/reviews/11';
  const SHA = '7b216de1f2a3b4c5d6e7f8091a2b3c4d5e6f7081';
  const get = (args) => call('get_review', { credential_file: cred(), owner: 'o', repo: 'r', index: 7, ...args });

  it('returns one review with its full, uncapped body', async () => {
    const body = 'z'.repeat(10001);
    host = await fakeHost({
      [ROUTE]: () => ({ json: { id: 11, state: 'APPROVED', body, commit_id: SHA, user: { login: 'u' }, stale: false, dismissed: false, html_url: 'http://x/11' } }),
    });
    const r = await get({ id: 11 });
    expect(r.structuredContent.outcome).toBe('ok');
    expect(r.structuredContent.effect).toBe('read');
    expect(r.structuredContent.data.body).toBe(body);
    expect(r.structuredContent.data.body).toHaveLength(10001);
    expect(r.structuredContent.data.body_truncated).toBeUndefined();
    expect(r.structuredContent.data.commit_id).toBe(SHA);
    expect(r.structuredContent.data.stale).toBe(false);
  });

  it('maps a missing review to failed/not_found', async () => {
    host = await fakeHost({ [ROUTE]: () => ({ status: 404, json: { message: 'no' } }) });
    const r = await get({ id: 11 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.reason).toBe('not_found');
  });

  it('requires the review id', async () => {
    host = await fakeHost({});
    const r = await get({});
    expect(r.structuredContent.reason).toBe('validation_failed');
    expect(host.requests).toHaveLength(0);
  });
});
