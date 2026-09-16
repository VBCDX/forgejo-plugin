// Issue reads and writes. update_issue is a general edit and, per this
// contract, legitimately carries an open|closed state field: closing is an
// ordinary write here, gated only by the write mode and by the token's
// repository permissions — there is no role matrix in vbcdx.forgejo/1.

import {
  getJson,
  verifyGet,
  inputSchema,
  ownerRepo,
  pageLimit,
  positiveInt,
  bodyText,
  pagedEnvelope,
  resolvePage,
  resolveLimit,
  success,
  unverifiedSpec,
} from '../toolkit.js';
import { envelopeSchema, S, paged } from '../schemas.js';
import { projectIssue } from '../projections.js';
import { failed, refused } from '../errors.js';

const seg = encodeURIComponent;

const assigneesSchema = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 } };
const labelIdsSchema = { type: 'array', items: positiveInt };

function issuePath(args, sub = '') {
  return `/repos/${seg(args.owner)}/${seg(args.repo)}/issues${sub}`;
}

// Compare only the fields this call asked to set, plus identity.
function compareIssue(requested, got) {
  if (got.number !== requested.number) return 'number';
  if (requested.title !== undefined && got.title !== requested.title) return 'title';
  if (requested.body !== undefined && (got.body ?? '') !== requested.body) return 'body';
  if (requested.state !== undefined && got.state !== requested.state) return 'state';
  if (requested.milestoneId !== undefined) {
    const gotId = got.milestone ? got.milestone.id : 0;
    if (gotId !== requested.milestoneId) return 'milestone';
  }
  if (requested.assignees !== undefined) {
    const gotSet = new Set((got.assignees || []).map((a) => a.login));
    if (gotSet.size !== requested.assignees.length || !requested.assignees.every((a) => gotSet.has(a))) {
      return 'assignees';
    }
  }
  return null;
}

export const issueTools = [
  {
    name: 'list_issues',
    description: 'List issues in a repository (pull requests are excluded).',
    effect: 'read',
    permissions: ['read:issue'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/issues',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        labels: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 } },
        q: { type: 'string', maxLength: 256 },
        ...pageLimit,
      },
      required: ['owner', 'repo'],
    }),
    output: envelopeSchema(paged(S.issue)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = issuePath(args);
      const query = { type: 'issues', state: args.state ?? 'open', page, limit };
      if (args.labels && args.labels.length) query.labels = args.labels.join(',');
      if (args.q) query.q = args.q;
      const r = await getJson(call, 'read', { method: 'GET', path, query, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map((i) => projectIssue(i));
      return success({
        method: 'GET',
        path,
        status: r.status,
        data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }),
      });
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number, including its body.',
    effect: 'read',
    permissions: ['read:issue'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/issues/{index}',
    input: inputSchema({ properties: { ...ownerRepo, index: positiveInt }, required: ['owner', 'repo', 'index'] }),
    output: envelopeSchema(S.issue),
    async run({ args, call, auth }) {
      const path = issuePath(args, `/${args.index}`);
      const r = await getJson(call, 'read', { method: 'GET', path, auth });
      if (r.json && r.json.pull_request) {
        throw Object.assign(failed('not_found', 'That number is a pull request, not an issue.', { httpStatus: r.status, attempted: true }), {
          request: { method: 'GET', path, attempted: true },
        });
      }
      return success({ method: 'GET', path, status: r.status, data: projectIssue(r.json, { detail: true }) });
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue, then read it back to verify the requested fields.',
    effect: 'write',
    permissions: ['write:issue'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/issues',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        title: { type: 'string', minLength: 1, maxLength: 255 },
        body: bodyText,
        assignees: assigneesSchema,
        labels: labelIdsSchema,
        milestone: positiveInt,
      },
      required: ['owner', 'repo', 'title'],
    }),
    output: envelopeSchema(S.issue),
    async run({ args, call, auth }) {
      const path = issuePath(args);
      const body = { title: args.title };
      if (args.body !== undefined) body.body = args.body;
      if (args.assignees !== undefined) body.assignees = args.assignees;
      if (args.labels !== undefined) body.labels = args.labels;
      if (args.milestone !== undefined) body.milestone = args.milestone;

      const r = await getJson(call, 'mutation', { method: 'POST', path, body, auth });
      const number = r.json?.number;
      if (typeof number !== 'number') {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The issue was created but the response did not include its number to verify.' });
      }
      const verifyPath = issuePath(args, `/${number}`);
      const check = await verifyGet(call, { method: 'GET', path: verifyPath, auth });
      const requested = { number, title: args.title, body: args.body, milestoneId: args.milestone, assignees: args.assignees };
      if (!check.ok) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The issue was created but could not be read back to confirm.', evidence: { number } });
      }
      const mismatch = compareIssue(requested, check.json);
      if (mismatch) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, verification: 'mismatch', message: `The created issue's ${mismatch} did not match what was requested.`, evidence: { number } });
      }
      return success({ outcome: 'ok', method: 'POST', path, status: r.status, verification: 'confirmed', data: projectIssue(check.json, { detail: true }) });
    },
  },
  {
    name: 'update_issue',
    description: 'Edit an issue (title/body/state/assignees/milestone), then read it back to verify the changed fields.',
    effect: 'write',
    permissions: ['write:issue'],
    method: 'PATCH',
    route: '/repos/{owner}/{repo}/issues/{index}',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        index: positiveInt,
        title: { type: 'string', minLength: 1, maxLength: 255 },
        body: bodyText,
        state: { type: 'string', enum: ['open', 'closed'] },
        assignees: assigneesSchema,
        milestone: { type: ['integer', 'null'], minimum: 1 },
        expected_updated_at: { type: 'string', minLength: 1, maxLength: 64 },
      },
      required: ['owner', 'repo', 'index'],
    }),
    output: envelopeSchema(S.issue),
    async run({ args, call, auth }) {
      const changed = ['title', 'body', 'state', 'assignees', 'milestone'].filter((k) => args[k] !== undefined);
      if (changed.length === 0) {
        throw refused('validation_failed', 'update_issue requires at least one field to change.');
      }
      const detailPath = issuePath(args, `/${args.index}`);

      // Advisory preflight: guard against a stale edit when expected_updated_at
      // is supplied. Issues have no atomic condition, so this is a check, not a
      // compare-and-swap.
      if (args.expected_updated_at !== undefined) {
        const pre = await getJson(call, 'preflight', { method: 'GET', path: detailPath, auth });
        if (pre.json?.updated_at !== args.expected_updated_at) {
          throw Object.assign(failed('conflict', 'The issue changed since expected_updated_at; refusing to overwrite.', { httpStatus: pre.status, attempted: false, evidence: { observed_updated_at: pre.json?.updated_at } }), {
            request: { method: 'PATCH', path: detailPath, attempted: false },
          });
        }
      }

      const body = {};
      if (args.title !== undefined) body.title = args.title;
      if (args.body !== undefined) body.body = args.body;
      if (args.state !== undefined) body.state = args.state;
      if (args.assignees !== undefined) body.assignees = args.assignees;
      if (args.milestone !== undefined) body.milestone = args.milestone === null ? 0 : args.milestone;

      const r = await getJson(call, 'mutation', { method: 'PATCH', path: detailPath, body, auth });
      const check = await verifyGet(call, { method: 'GET', path: detailPath, auth });
      const requested = {
        number: args.index,
        title: args.title,
        body: args.body,
        state: args.state,
        milestoneId: args.milestone === undefined ? undefined : args.milestone === null ? 0 : args.milestone,
        assignees: args.assignees,
      };
      if (!check.ok) {
        return unverifiedSpec({ method: 'PATCH', path: detailPath, status: r.status, message: 'The edit was accepted but could not be read back to confirm.', evidence: { number: args.index } });
      }
      const mismatch = compareIssue(requested, check.json);
      if (mismatch) {
        return unverifiedSpec({ method: 'PATCH', path: detailPath, status: r.status, verification: 'mismatch', message: `After the edit, ${mismatch} did not match what was requested.`, evidence: { number: args.index } });
      }
      return success({ outcome: 'ok', method: 'PATCH', path: detailPath, status: r.status, verification: 'confirmed', data: projectIssue(check.json, { detail: true }) });
    },
  },
];
