// Commit status reads and writes. Setting a status reports the supplied
// verdict; the server does not itself perform any audit the status names.

import {
  getJson,
  verifyGet,
  inputSchema,
  ownerRepo,
  pageLimit,
  shaSchema,
  pagedEnvelope,
  resolvePage,
  resolveLimit,
  success,
  unverifiedSpec,
} from '../toolkit.js';
import { envelopeSchema, S, paged } from '../schemas.js';
import { projectStatus } from '../projections.js';
import { refused } from '../errors.js';

const seg = encodeURIComponent;
const repoBase = (a) => `/repos/${seg(a.owner)}/${seg(a.repo)}`;

function assertHttpUrl(value, field) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw refused('validation_failed', `${field} must be an absolute http(s) URL.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw refused('validation_failed', `${field} must use http or https.`);
  }
  if (u.username || u.password) {
    throw refused('validation_failed', `${field} must not embed userinfo.`);
  }
}

export const statusTools = [
  {
    name: 'list_commit_statuses',
    description: 'List the statuses posted against a commit SHA.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/statuses/{sha}',
    input: inputSchema({ properties: { ...ownerRepo, sha: shaSchema, ...pageLimit }, required: ['owner', 'repo', 'sha'] }),
    output: envelopeSchema(paged(S.status)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = `${repoBase(args)}/statuses/${args.sha}`;
      const r = await getJson(call, 'read', { method: 'GET', path, query: { page, limit }, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map(projectStatus);
      return success({ method: 'GET', path, status: r.status, data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }) });
    },
  },
  {
    name: 'set_commit_status',
    description: 'Post a status against a commit SHA, then read the latest status for that context to verify it.',
    effect: 'write',
    permissions: ['write:repository'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/statuses/{sha}',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        sha: shaSchema,
        state: { type: 'string', enum: ['pending', 'success', 'error', 'failure', 'warning'] },
        context: { type: 'string', minLength: 1, maxLength: 255 },
        description: { type: 'string', maxLength: 255 },
        target_url: { type: 'string', maxLength: 2048 },
      },
      required: ['owner', 'repo', 'sha', 'state', 'context'],
    }),
    output: envelopeSchema(S.status),
    async run({ args, call, auth }) {
      if (args.target_url !== undefined) assertHttpUrl(args.target_url, 'target_url');
      const path = `${repoBase(args)}/statuses/${args.sha}`;
      const body = { state: args.state, context: args.context };
      if (args.description !== undefined) body.description = args.description;
      if (args.target_url !== undefined) body.target_url = args.target_url;

      const r = await getJson(call, 'mutation', { method: 'POST', path, body, auth });

      // Verify by reading the statuses for the SHA and taking the latest entry
      // for the requested context.
      const check = await verifyGet(call, { method: 'GET', path, query: { page: 1, limit: 50 }, auth });
      if (!check.ok || !Array.isArray(check.json)) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The status was posted but could not be read back to confirm.', evidence: { context: args.context } });
      }
      const forContext = check.json.filter((s) => s.context === args.context);
      const latest = forContext[0]; // Forgejo returns newest first
      const observedState = latest ? (latest.status ?? latest.state) : undefined;
      if (!latest || observedState !== args.state) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, verification: 'mismatch', message: 'The latest status for that context did not match the requested state.', evidence: { context: args.context, observed_state: observedState } });
      }
      return success({ method: 'POST', path, status: r.status, verification: 'confirmed', data: projectStatus(latest) });
    },
  },
];
