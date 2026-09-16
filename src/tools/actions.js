// Forgejo Actions reads and writes. There is deliberately no CI re-run tool:
// this instance's API exposes no rerun route, so the catalog does not claim one.

import {
  getJson,
  windowEnvelope,
  unwrapArray,
  inputSchema,
  ownerRepo,
  pageLimit,
  offsetLimit,
  positiveInt,
  shaSchema,
  pagedEnvelope,
  resolvePage,
  resolveLimit,
  success,
} from '../toolkit.js';
import { envelopeSchema, S, paged, windowed } from '../schemas.js';
import { projectRun, projectJob } from '../projections.js';
import { MAX_LIMIT } from '../constants.js';

const seg = encodeURIComponent;
const repoBase = (a) => `/repos/${seg(a.owner)}/${seg(a.repo)}`;

export const actionTools = [
  {
    name: 'list_workflow_runs',
    description: 'List Actions workflow runs in a repository.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/actions/runs',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        head_sha: shaSchema,
        ref: { type: 'string', minLength: 1, maxLength: 255 },
        workflow_id: { type: 'string', minLength: 1, maxLength: 255 },
        ...pageLimit,
      },
      required: ['owner', 'repo'],
    }),
    output: envelopeSchema(paged(S.run)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = `${repoBase(args)}/actions/runs`;
      const query = { page, limit };
      if (args.head_sha) query.head_sha = args.head_sha;
      if (args.ref) query.ref = args.ref;
      if (args.workflow_id) query.workflow_id = args.workflow_id;
      const r = await getJson(call, 'read', { method: 'GET', path, query, auth });
      const runs = unwrapArray(r.json, ['workflow_runs']);
      const items = runs.map(projectRun);
      const total = r.json && typeof r.json.total_count === 'number' ? r.json.total_count : r.headers.totalCount ?? undefined;
      return success({ method: 'GET', path, status: r.status, data: pagedEnvelope({ items, page, limit, total }) });
    },
  },
  {
    name: 'get_workflow_run',
    description: 'Get a single Actions workflow run by id.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/actions/runs/{run_id}',
    input: inputSchema({ properties: { ...ownerRepo, run_id: positiveInt }, required: ['owner', 'repo', 'run_id'] }),
    output: envelopeSchema(S.run),
    async run({ args, call, auth }) {
      const path = `${repoBase(args)}/actions/runs/${args.run_id}`;
      const r = await getJson(call, 'read', { method: 'GET', path, auth });
      return success({ method: 'GET', path, status: r.status, data: projectRun(r.json) });
    },
  },
  {
    name: 'list_workflow_jobs',
    description: 'List the jobs of a workflow run, as a local window.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
    input: inputSchema({ properties: { ...ownerRepo, run_id: positiveInt, ...offsetLimit }, required: ['owner', 'repo', 'run_id'] }),
    output: envelopeSchema(windowed(S.job)),
    async run({ args, call, auth }) {
      const offset = args.offset ?? 0;
      const limit = resolveLimit(args.limit);
      const path = `${repoBase(args)}/actions/runs/${args.run_id}/jobs`;
      // The jobs endpoint returns the run's full job set; retrieve once and
      // window locally. A full page is treated as possibly-incomplete.
      const r = await getJson(call, 'read', { method: 'GET', path, query: { page: 1, limit: MAX_LIMIT }, auth });
      const jobs = unwrapArray(r.json, ['jobs', 'workflow_jobs']);
      const terminal = jobs.length < MAX_LIMIT;
      const projected = jobs.map(projectJob);
      return success({ method: 'GET', path, status: r.status, data: windowEnvelope({ array: projected, offset, limit, terminal }) });
    },
  },
  {
    name: 'dispatch_workflow',
    description: 'Trigger a workflow_dispatch run on a ref. Acknowledgement only; the run’s outcome is not awaited.',
    effect: 'write',
    permissions: ['write:repository'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        workflow: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\s]+$' },
        ref: { type: 'string', minLength: 1, maxLength: 255 },
        inputs: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['owner', 'repo', 'workflow', 'ref'],
    }),
    output: envelopeSchema(S.dispatched),
    async run({ args, call, auth }) {
      const path = `${repoBase(args)}/actions/workflows/${seg(args.workflow)}/dispatches`;
      const body = { ref: args.ref, return_run_info: true };
      if (args.inputs !== undefined) body.inputs = args.inputs;
      const r = await getJson(call, 'mutation', { method: 'POST', path, body, auth });
      const data = { accepted: true };
      if (r.json && typeof r.json.id === 'number') data.run_id = r.json.id;
      return success({ outcome: 'accepted', method: 'POST', path, status: r.status, verification: 'not_applicable', data });
    },
  },
  {
    name: 'cancel_workflow_run',
    description: 'Request cancellation of a workflow run. Cancellation is acknowledged, not confirmed complete.',
    effect: 'destructive',
    permissions: ['write:repository'],
    method: 'POST',
    route: '/repos/{owner}/{repo}/actions/runs/{run_id}/cancel',
    input: inputSchema({
      properties: { ...ownerRepo, run_id: positiveInt, confirm: { type: 'string', minLength: 1 } },
      required: ['owner', 'repo', 'run_id', 'confirm'],
    }),
    output: envelopeSchema(S.cancelled),
    confirm: (a) => `cancel workflow run ${a.owner}/${a.repo}#${a.run_id}`,
    async run({ args, call, auth }) {
      const path = `${repoBase(args)}/actions/runs/${args.run_id}/cancel`;
      const r = await getJson(call, 'mutation', { method: 'POST', path, auth });
      // Cancellation is asynchronous: report accepted with pending verification,
      // never claim the run has stopped.
      return success({
        outcome: 'accepted',
        method: 'POST',
        path,
        status: r.status,
        verification: 'pending',
        data: { run_id: args.run_id, accepted: true },
      });
    },
  },
];
