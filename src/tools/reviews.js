// Pull request reviews and merges. The merge endpoint's head_commit_id supplies
// the real atomic head check; a preflight alone never replaces it, and the
// server never force-merges or claims checks are satisfied on a caller's word.

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
import { projectReview } from '../projections.js';
import { failed } from '../errors.js';

const seg = encodeURIComponent;
const repoBase = (a) => `/repos/${seg(a.owner)}/${seg(a.repo)}`;
const pullPath = (a, sub = '') => `${repoBase(a)}/pulls/${a.index}${sub}`;

export const reviewTools = [
  {
    name: 'list_reviews',
    description: 'List the reviews on a pull request.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/pulls/{index}/reviews',
    input: inputSchema({ properties: { ...ownerRepo, index: positiveInt, ...pageLimit }, required: ['owner', 'repo', 'index'] }),
    output: envelopeSchema(paged(S.review)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = pullPath(args, '/reviews');
      const r = await getJson(call, 'read', { method: 'GET', path, query: { page, limit }, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map(projectReview);
      return success({ method: 'GET', path, status: r.status, data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }) });
    },
  },
  {
    name: 'create_review',
    description: 'Submit a review (COMMENT, APPROVED or REQUEST_CHANGES) pinned to expected_head_sha, then read it back.',
    effect: 'write',
    permissions: ['write:repository'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/pulls/{index}/reviews',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        index: positiveInt,
        expected_head_sha: shaSchema,
        event: { type: 'string', enum: ['COMMENT', 'APPROVED', 'REQUEST_CHANGES'] },
        body: bodyText,
      },
      required: ['owner', 'repo', 'index', 'expected_head_sha', 'event', 'body'],
    }),
    output: envelopeSchema(S.review),
    async run({ args, call, auth }) {
      const path = pullPath(args, '/reviews');
      const pre = await getJson(call, 'preflight', { method: 'GET', path: pullPath(args), auth });
      if (pre.json?.head?.sha !== args.expected_head_sha) {
        throw Object.assign(failed('conflict', 'The pull request head changed since expected_head_sha; refusing to review a stale head.', { httpStatus: pre.status, attempted: false, evidence: { observed_head_sha: pre.json?.head?.sha } }), {
          request: { method: 'POST', path, attempted: false },
        });
      }

      const r = await getJson(call, 'mutation', {
        method: 'POST',
        path,
        body: { commit_id: args.expected_head_sha, event: args.event, body: args.body },
        auth,
      });
      const id = r.json?.id;
      if (typeof id !== 'number') {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The review was submitted but its id was not returned to verify.' });
      }
      const check = await verifyGet(call, { method: 'GET', path: pullPath(args, `/reviews/${id}`), auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The review was submitted but could not be read back to confirm.', evidence: { id } });
      }
      if (check.json.commit_id && check.json.commit_id !== args.expected_head_sha) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, verification: 'mismatch', message: 'The stored review targets a different commit than expected_head_sha.', evidence: { id, observed_commit_id: check.json.commit_id } });
      }
      return success({ method: 'POST', path, status: r.status, verification: 'confirmed', data: projectReview(check.json) });
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request only when its head still matches expected_head_sha, then verify it merged.',
    effect: 'destructive',
    permissions: ['write:repository'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/pulls/{index}/merge',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        index: positiveInt,
        expected_head_sha: shaSchema,
        method: { type: 'string', enum: ['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'] },
        confirm: { type: 'string', minLength: 1 },
      },
      required: ['owner', 'repo', 'index', 'expected_head_sha', 'method', 'confirm'],
    }),
    output: envelopeSchema(S.merged),
    confirm: (a) => `merge pull request ${a.owner}/${a.repo}#${a.index} at ${a.expected_head_sha}`,
    async run({ args, call, auth }) {
      const path = pullPath(args, '/merge');
      const pre = await getJson(call, 'preflight', { method: 'GET', path: pullPath(args), auth });
      if (pre.json?.head?.sha !== args.expected_head_sha) {
        throw Object.assign(failed('conflict', 'The pull request head changed since expected_head_sha; refusing to merge a stale head.', { httpStatus: pre.status, attempted: false, evidence: { observed_head_sha: pre.json?.head?.sha } }), {
          request: { method: 'POST', path, attempted: false },
        });
      }

      const r = await getJson(call, 'mutation', {
        method: 'POST',
        path,
        body: {
          Do: args.method,
          head_commit_id: args.expected_head_sha,
          force_merge: false,
          merge_when_checks_succeed: false,
          delete_branch_after_merge: false,
        },
        auth,
      });

      const check = await verifyGet(call, { method: 'GET', path: pullPath(args), auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The merge returned success but the pull request could not be read back to confirm.', evidence: { number: args.index } });
      }
      if (check.json.merged !== true) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, verification: 'mismatch', message: 'The merge returned success but the pull request does not report as merged.', evidence: { number: args.index } });
      }
      const data = { number: check.json.number ?? args.index, merged: true };
      if (check.json.merge_commit_sha != null) data.merge_commit_sha = check.json.merge_commit_sha;
      return success({ method: 'POST', path, status: r.status, verification: 'confirmed', data });
    },
  },
];
