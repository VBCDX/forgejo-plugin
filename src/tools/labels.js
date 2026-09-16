// Repository label and milestone reads, and setting an issue's label set.

import {
  getJson,
  verifyGet,
  inputSchema,
  ownerRepo,
  pageLimit,
  positiveInt,
  pagedEnvelope,
  resolvePage,
  resolveLimit,
  success,
  unverifiedSpec,
} from '../toolkit.js';
import { envelopeSchema, S, paged } from '../schemas.js';
import { projectLabel, projectMilestone } from '../projections.js';
import { failed } from '../errors.js';

const seg = encodeURIComponent;
const repoBase = (a) => `/repos/${seg(a.owner)}/${seg(a.repo)}`;

const sameSet = (a, b) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

export const labelTools = [
  {
    name: 'list_labels',
    description: 'List a repository’s labels.',
    effect: 'read',
    permissions: ['read:issue'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/labels',
    input: inputSchema({ properties: { ...ownerRepo, ...pageLimit }, required: ['owner', 'repo'] }),
    output: envelopeSchema(paged(S.label)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = `${repoBase(args)}/labels`;
      const r = await getJson(call, 'read', { method: 'GET', path, query: { page, limit }, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map(projectLabel);
      return success({ method: 'GET', path, status: r.status, data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }) });
    },
  },
  {
    name: 'list_milestones',
    description: 'List a repository’s milestones.',
    effect: 'read',
    permissions: ['read:issue'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/milestones',
    input: inputSchema({
      properties: { ...ownerRepo, state: { type: 'string', enum: ['open', 'closed', 'all'] }, ...pageLimit },
      required: ['owner', 'repo'],
    }),
    output: envelopeSchema(paged(S.milestone)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = `${repoBase(args)}/milestones`;
      const r = await getJson(call, 'read', { method: 'GET', path, query: { state: args.state ?? 'open', page, limit }, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map(projectMilestone);
      return success({ method: 'GET', path, status: r.status, data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }) });
    },
  },
  {
    name: 'set_issue_labels',
    description: 'Replace an issue’s label set (an empty list clears it), then verify the resulting set.',
    effect: 'write',
    permissions: ['write:issue'],
    method: 'PUT',
    route: '/repos/{owner}/{repo}/issues/{index}/labels',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        index: positiveInt,
        labels: { type: 'array', items: positiveInt },
        expected_labels: { type: 'array', items: positiveInt },
      },
      required: ['owner', 'repo', 'index', 'labels'],
    }),
    output: envelopeSchema(S.issueLabels),
    async run({ args, call, auth }) {
      const path = `${repoBase(args)}/issues/${args.index}/labels`;

      // Advisory preflight: only overwrite the label set the caller expects.
      if (args.expected_labels !== undefined) {
        const pre = await getJson(call, 'preflight', { method: 'GET', path, auth });
        const currentIds = (Array.isArray(pre.json) ? pre.json : []).map((l) => l.id);
        if (!sameSet(currentIds, args.expected_labels)) {
          throw Object.assign(failed('conflict', 'The issue’s labels changed since expected_labels; refusing to overwrite.', { httpStatus: pre.status, attempted: false, evidence: { observed_label_ids: currentIds } }), {
            request: { method: 'PUT', path, attempted: false },
          });
        }
      }

      const r = await getJson(call, 'mutation', { method: 'PUT', path, body: { labels: args.labels }, auth });
      const check = await verifyGet(call, { method: 'GET', path, auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'PUT', path, status: r.status, message: 'The labels were set but could not be read back to confirm.', evidence: { index: args.index } });
      }
      const gotLabels = Array.isArray(check.json) ? check.json : [];
      const gotIds = gotLabels.map((l) => l.id);
      if (!sameSet(gotIds, args.labels)) {
        return unverifiedSpec({ method: 'PUT', path, status: r.status, verification: 'mismatch', message: 'The resulting label set did not match what was requested.', evidence: { index: args.index, observed_label_ids: gotIds } });
      }
      return success({ method: 'PUT', path, status: r.status, verification: 'confirmed', data: { index: args.index, labels: gotLabels.map(projectLabel) } });
    },
  },
];
