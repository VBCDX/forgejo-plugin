// Issue/PR comment reads and writes. Comment bodies round-trip literally,
// including trailing newlines. Edits and deletes take an expected_body_sha256
// digest so a stale body is refused rather than clobbered.

import {
  getJson,
  verifyGet,
  fetchArrayBounded,
  windowEnvelope,
  inputSchema,
  ownerRepo,
  offsetLimit,
  positiveInt,
  bodyText,
  resolveLimit,
  success,
  unverifiedSpec,
  sha256,
} from '../toolkit.js';
import { envelopeSchema, S, windowed } from '../schemas.js';
import { projectComment } from '../projections.js';
import { failed } from '../errors.js';

const seg = encodeURIComponent;

const repoBase = (a) => `/repos/${seg(a.owner)}/${seg(a.repo)}`;
const commentPath = (a) => `${repoBase(a)}/issues/comments/${a.id}`;

export const commentTools = [
  {
    name: 'list_comments',
    description: 'List comments on an issue or pull request, as a local window.',
    effect: 'read',
    permissions: ['read:issue'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/issues/{index}/comments',
    input: inputSchema({ properties: { ...ownerRepo, index: positiveInt, ...offsetLimit }, required: ['owner', 'repo', 'index'] }),
    output: envelopeSchema(windowed(S.comment)),
    async run({ args, call, auth }) {
      const offset = args.offset ?? 0;
      const limit = resolveLimit(args.limit);
      const path = `${repoBase(args)}/issues/${args.index}/comments`;
      const { array, terminal } = await fetchArrayBounded(call, 'read', { path, auth, need: offset + limit });
      const projected = array.map(projectComment);
      return success({
        method: 'GET',
        path,
        data: windowEnvelope({ array: projected, offset, limit, terminal }),
      });
    },
  },
  {
    name: 'get_comment',
    description: 'Get a single comment by id.',
    effect: 'read',
    permissions: ['read:issue'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/issues/comments/{id}',
    input: inputSchema({ properties: { ...ownerRepo, id: positiveInt }, required: ['owner', 'repo', 'id'] }),
    output: envelopeSchema(S.comment),
    async run({ args, call, auth }) {
      const path = commentPath(args);
      const r = await getJson(call, 'read', { method: 'GET', path, auth });
      return success({ method: 'GET', path, status: r.status, data: projectComment(r.json) });
    },
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue or pull request, then read it back to confirm the body.',
    effect: 'write',
    permissions: ['write:issue'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/issues/{index}/comments',
    input: inputSchema({ properties: { ...ownerRepo, index: positiveInt, body: bodyText }, required: ['owner', 'repo', 'index', 'body'] }),
    output: envelopeSchema(S.comment),
    async run({ args, call, auth }) {
      const path = `${repoBase(args)}/issues/${args.index}/comments`;
      const r = await getJson(call, 'mutation', { method: 'POST', path, body: { body: args.body }, auth });
      const id = r.json?.id;
      if (typeof id !== 'number') {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The comment was created but its id was not returned to verify.' });
      }
      const check = await verifyGet(call, { method: 'GET', path: `${repoBase(args)}/issues/comments/${id}`, auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The comment was created but could not be read back to confirm.', evidence: { id } });
      }
      if ((check.json.body ?? '') !== args.body) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, verification: 'mismatch', message: 'The stored comment body did not match what was sent.', evidence: { id } });
      }
      return success({ method: 'POST', path, status: r.status, verification: 'confirmed', data: projectComment(check.json) });
    },
  },
  {
    name: 'update_comment',
    description: 'Edit a comment whose current body matches expected_body_sha256, then read back the exact new body.',
    effect: 'write',
    permissions: ['write:issue'],
    method: 'PATCH',
    route: '/repos/{owner}/{repo}/issues/comments/{id}',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        id: positiveInt,
        body: bodyText,
        expected_body_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      },
      required: ['owner', 'repo', 'id', 'body', 'expected_body_sha256'],
    }),
    output: envelopeSchema(S.comment),
    async run({ args, call, auth }) {
      const path = commentPath(args);
      const pre = await getJson(call, 'preflight', { method: 'GET', path, auth });
      const currentDigest = sha256(pre.json?.body ?? '');
      if (currentDigest !== args.expected_body_sha256) {
        throw Object.assign(failed('conflict', 'The comment body changed since expected_body_sha256; refusing to overwrite.', { httpStatus: pre.status, attempted: false }), {
          request: { method: 'PATCH', path, attempted: false },
        });
      }
      const r = await getJson(call, 'mutation', { method: 'PATCH', path, body: { body: args.body }, auth });
      const check = await verifyGet(call, { method: 'GET', path, auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'PATCH', path, status: r.status, message: 'The edit was accepted but could not be read back to confirm.', evidence: { id: args.id } });
      }
      if ((check.json.body ?? '') !== args.body) {
        return unverifiedSpec({ method: 'PATCH', path, status: r.status, verification: 'mismatch', message: 'The stored comment body did not match the new body.', evidence: { id: args.id } });
      }
      return success({ method: 'PATCH', path, status: r.status, verification: 'confirmed', data: projectComment(check.json) });
    },
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment whose current body matches expected_body_sha256, then verify it is gone.',
    effect: 'destructive',
    permissions: ['write:issue'],
    method: 'DELETE',
    route: '/repos/{owner}/{repo}/issues/comments/{id}',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        id: positiveInt,
        expected_body_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        confirm: { type: 'string', minLength: 1 },
      },
      required: ['owner', 'repo', 'id', 'expected_body_sha256', 'confirm'],
    }),
    output: envelopeSchema(S.deleted),
    confirm: (a) => `delete comment ${a.owner}/${a.repo}#${a.id}`,
    async run({ args, call, auth }) {
      const path = commentPath(args);
      const pre = await getJson(call, 'preflight', { method: 'GET', path, auth });
      const currentDigest = sha256(pre.json?.body ?? '');
      if (currentDigest !== args.expected_body_sha256) {
        throw Object.assign(failed('conflict', 'The comment body changed since expected_body_sha256; refusing to delete.', { httpStatus: pre.status, attempted: false }), {
          request: { method: 'DELETE', path, attempted: false },
        });
      }
      const r = await getJson(call, 'mutation', { method: 'DELETE', path, auth });
      const gone = await verifyGet(call, { method: 'GET', path, auth });
      if (gone.ok) {
        return unverifiedSpec({ method: 'DELETE', path, status: r.status, verification: 'mismatch', message: 'The delete returned success but the comment is still readable.', evidence: { id: args.id } });
      }
      if (gone.status !== 404) {
        return unverifiedSpec({ method: 'DELETE', path, status: r.status, message: 'The delete returned success but absence could not be confirmed.', evidence: { id: args.id } });
      }
      return success({ method: 'DELETE', path, status: r.status, verification: 'confirmed', data: { id: args.id, deleted: true } });
    },
  },
];
