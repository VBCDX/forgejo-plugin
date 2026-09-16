// Pull request reads and writes.

import {
  getJson,
  verifyGet,
  inputSchema,
  ownerRepo,
  pageLimit,
  positiveInt,
  shaSchema,
  bodyText,
  pagedEnvelope,
  resolvePage,
  resolveLimit,
  success,
  unverifiedSpec,
} from '../toolkit.js';
import { envelopeSchema, S, paged } from '../schemas.js';
import { projectPull } from '../projections.js';
import { failed, refused } from '../errors.js';
import { MAX_STRUCTURED_BYTES } from '../constants.js';

const seg = encodeURIComponent;
const repoBase = (a) => `/repos/${seg(a.owner)}/${seg(a.repo)}`;
const pullPath = (a, sub = '') => `${repoBase(a)}/pulls/${a.index}${sub}`;

const assigneesSchema = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 } };
const labelIdsSchema = { type: 'array', items: positiveInt };
const refSchema = { type: 'string', minLength: 1, maxLength: 255 };

const DIFF_CAP = MAX_STRUCTURED_BYTES - 4096;

function projectPrFile(f) {
  const out = {};
  for (const k of ['filename', 'previous_filename', 'status', 'additions', 'deletions', 'changes']) {
    if (f[k] !== undefined && f[k] !== null) out[k] = f[k];
  }
  return out;
}

function comparePull(requested, got) {
  if (got.number !== requested.number) return 'number';
  if (requested.title !== undefined && got.title !== requested.title) return 'title';
  if (requested.body !== undefined && (got.body ?? '') !== requested.body) return 'body';
  if (requested.state !== undefined && got.state !== requested.state) return 'state';
  if (requested.base !== undefined && got.base?.ref !== requested.base) return 'base';
  return null;
}

export const pullTools = [
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/pulls',
    input: inputSchema({
      properties: { ...ownerRepo, state: { type: 'string', enum: ['open', 'closed', 'all'] }, base: refSchema, head: refSchema, ...pageLimit },
      required: ['owner', 'repo'],
    }),
    output: envelopeSchema(paged(S.pull)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = `${repoBase(args)}/pulls`;
      const query = { state: args.state ?? 'open', page, limit };
      if (args.base) query.base = args.base;
      if (args.head) query.head = args.head;
      const r = await getJson(call, 'read', { method: 'GET', path, query, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map((p) => projectPull(p));
      return success({ method: 'GET', path, status: r.status, data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }) });
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a single pull request, including its body and file counts.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/pulls/{index}',
    input: inputSchema({ properties: { ...ownerRepo, index: positiveInt }, required: ['owner', 'repo', 'index'] }),
    output: envelopeSchema(S.pull),
    async run({ args, call, auth }) {
      const path = pullPath(args);
      const r = await getJson(call, 'read', { method: 'GET', path, auth });
      return success({ method: 'GET', path, status: r.status, data: projectPull(r.json, { detail: true }) });
    },
  },
  {
    name: 'list_pull_request_files',
    description: 'List the files changed by a pull request.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/pulls/{index}/files',
    input: inputSchema({ properties: { ...ownerRepo, index: positiveInt, ...pageLimit }, required: ['owner', 'repo', 'index'] }),
    output: envelopeSchema(paged(S.prFile)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = pullPath(args, '/files');
      const r = await getJson(call, 'read', { method: 'GET', path, query: { page, limit }, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map(projectPrFile);
      return success({ method: 'GET', path, status: r.status, data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }) });
    },
  },
  {
    name: 'get_pull_request_diff',
    description: 'Get the unified diff of a pull request. Large diffs are truncated with a flag.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/pulls/{index}.diff',
    input: inputSchema({ properties: { ...ownerRepo, index: positiveInt }, required: ['owner', 'repo', 'index'] }),
    output: envelopeSchema(S.diff),
    async run({ args, call, auth }) {
      const path = `${repoBase(args)}/pulls/${args.index}.diff`;
      const r = await getJson(call, 'read', { method: 'GET', path, accept: 'text/plain', auth });
      const full = r.text ?? '';
      const buf = Buffer.from(full, 'utf8');
      let diff = full;
      let truncated = false;
      if (buf.length > DIFF_CAP) {
        let end = DIFF_CAP;
        while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
        diff = buf.slice(0, end).toString('utf8');
        truncated = true;
      }
      return success({ method: 'GET', path, status: r.status, data: { diff, truncated } });
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request, then read it back to verify the requested fields.',
    effect: 'write',
    permissions: ['write:repository'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/pulls',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        head: refSchema,
        base: refSchema,
        title: { type: 'string', minLength: 1, maxLength: 255 },
        body: bodyText,
        assignees: assigneesSchema,
        labels: labelIdsSchema,
        milestone: positiveInt,
      },
      required: ['owner', 'repo', 'head', 'base', 'title'],
    }),
    output: envelopeSchema(S.pull),
    async run({ args, call, auth }) {
      const path = `${repoBase(args)}/pulls`;
      const body = { head: args.head, base: args.base, title: args.title };
      if (args.body !== undefined) body.body = args.body;
      if (args.assignees !== undefined) body.assignees = args.assignees;
      if (args.labels !== undefined) body.labels = args.labels;
      if (args.milestone !== undefined) body.milestone = args.milestone;

      const r = await getJson(call, 'mutation', { method: 'POST', path, body, auth });
      const number = r.json?.number;
      if (typeof number !== 'number') {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The pull request was created but its number was not returned to verify.' });
      }
      const check = await verifyGet(call, { method: 'GET', path: `${repoBase(args)}/pulls/${number}`, auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The pull request was created but could not be read back to confirm.', evidence: { number } });
      }
      const mismatch = comparePull({ number, title: args.title, body: args.body, base: args.base }, check.json);
      if (mismatch) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, verification: 'mismatch', message: `The created pull request's ${mismatch} did not match what was requested.`, evidence: { number } });
      }
      return success({ method: 'POST', path, status: r.status, verification: 'confirmed', data: projectPull(check.json, { detail: true }) });
    },
  },
  {
    name: 'update_pull_request',
    description: 'Edit a pull request when its head still matches expected_head_sha, then read it back to verify.',
    effect: 'write',
    permissions: ['write:repository'],
    method: 'PATCH',
    route: '/repos/{owner}/{repo}/pulls/{index}',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        index: positiveInt,
        title: { type: 'string', minLength: 1, maxLength: 255 },
        body: bodyText,
        state: { type: 'string', enum: ['open', 'closed'] },
        base: refSchema,
        assignees: assigneesSchema,
        labels: labelIdsSchema,
        expected_head_sha: shaSchema,
      },
      required: ['owner', 'repo', 'index', 'expected_head_sha'],
    }),
    output: envelopeSchema(S.pull),
    async run({ args, call, auth }) {
      const path = pullPath(args);
      const pre = await getJson(call, 'preflight', { method: 'GET', path, auth });
      if (pre.json?.head?.sha !== args.expected_head_sha) {
        throw Object.assign(failed('conflict', 'The pull request head changed since expected_head_sha; refusing to edit.', { httpStatus: pre.status, attempted: false, evidence: { observed_head_sha: pre.json?.head?.sha } }), {
          request: { method: 'PATCH', path, attempted: false },
        });
      }

      const body = {};
      if (args.title !== undefined) body.title = args.title;
      if (args.body !== undefined) body.body = args.body;
      if (args.state !== undefined) body.state = args.state;
      if (args.base !== undefined) body.base = args.base;
      if (args.assignees !== undefined) body.assignees = args.assignees;
      if (args.labels !== undefined) body.labels = args.labels;
      if (Object.keys(body).length === 0) {
        throw refused('validation_failed', 'update_pull_request requires at least one field to change.');
      }

      const r = await getJson(call, 'mutation', { method: 'PATCH', path, body, auth });
      const check = await verifyGet(call, { method: 'GET', path, auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'PATCH', path, status: r.status, message: 'The edit was accepted but could not be read back to confirm.', evidence: { number: args.index } });
      }
      const mismatch = comparePull({ number: args.index, title: args.title, body: args.body, state: args.state, base: args.base }, check.json);
      if (mismatch) {
        return unverifiedSpec({ method: 'PATCH', path, status: r.status, verification: 'mismatch', message: `After the edit, ${mismatch} did not match what was requested.`, evidence: { number: args.index } });
      }
      return success({ method: 'PATCH', path, status: r.status, verification: 'confirmed', data: projectPull(check.json, { detail: true }) });
    },
  },
];
