// Repository reads: organisation repo listing, single repo, branches, file.

import {
  getJson,
  inputSchema,
  ownerRepo,
  pageLimit,
  pagedEnvelope,
  resolvePage,
  resolveLimit,
  success,
} from '../toolkit.js';
import { envelopeSchema, S, paged } from '../schemas.js';
import { projectRepository, projectBranch } from '../projections.js';
import { failed } from '../errors.js';

const seg = encodeURIComponent;

export const repoTools = [
  {
    name: 'list_repositories',
    description: 'List repositories in an organisation.',
    effect: 'read',
    permissions: ['read:organization'],
    method: 'GET',
    route: '/orgs/{org}/repos',
    input: inputSchema({
      properties: {
        org: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\s/\\\\.][^\\s/\\\\]*$' },
        ...pageLimit,
      },
      required: ['org'],
    }),
    output: envelopeSchema(paged(S.repository)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = `/orgs/${seg(args.org)}/repos`;
      const r = await getJson(call, 'read', { method: 'GET', path, query: { page, limit }, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map(projectRepository);
      return success({
        method: 'GET',
        path,
        status: r.status,
        data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }),
      });
    },
  },
  {
    name: 'get_repository',
    description: 'Get a single repository by owner and name.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}',
    input: inputSchema({ properties: { ...ownerRepo }, required: ['owner', 'repo'] }),
    output: envelopeSchema(S.repository),
    async run({ args, call, auth }) {
      const path = `/repos/${seg(args.owner)}/${seg(args.repo)}`;
      const r = await getJson(call, 'read', { method: 'GET', path, auth });
      return success({ method: 'GET', path, status: r.status, data: projectRepository(r.json) });
    },
  },
  {
    name: 'list_branches',
    description: 'List branches of a repository.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/branches',
    input: inputSchema({ properties: { ...ownerRepo, ...pageLimit }, required: ['owner', 'repo'] }),
    output: envelopeSchema(paged(S.branch)),
    async run({ args, call, auth }) {
      const page = resolvePage(args.page);
      const limit = resolveLimit(args.limit);
      const path = `/repos/${seg(args.owner)}/${seg(args.repo)}/branches`;
      const r = await getJson(call, 'read', { method: 'GET', path, query: { page, limit }, auth });
      const items = (Array.isArray(r.json) ? r.json : []).map(projectBranch);
      return success({
        method: 'GET',
        path,
        status: r.status,
        data: pagedEnvelope({ items, page, limit, total: r.headers.totalCount ?? undefined }),
      });
    },
  },
  {
    name: 'get_file',
    description: 'Get a single file from a repository at a ref. Text is decoded UTF-8; binary is kept as explicit base64.',
    effect: 'read',
    permissions: ['read:repository'],
    method: 'GET',
    route: '/repos/{owner}/{repo}/contents/{path}',
    input: inputSchema({
      properties: {
        ...ownerRepo,
        path: { type: 'string', minLength: 1, maxLength: 1024 },
        ref: { type: 'string', minLength: 1, maxLength: 255 },
      },
      required: ['owner', 'repo', 'path', 'ref'],
    }),
    output: envelopeSchema(S.file),
    async run({ args, call, auth }) {
      // The file path may contain slashes; encode each segment but keep the
      // separators so the API sees the intended path.
      const encodedPath = args.path
        .split('/')
        .map((p) => seg(p))
        .join('/');
      const path = `/repos/${seg(args.owner)}/${seg(args.repo)}/contents/${encodedPath}`;
      const r = await getJson(call, 'read', { method: 'GET', path, query: { ref: args.ref }, auth });
      const c = r.json;
      if (!c || c.type !== 'file') {
        // Directories / submodules / symlinks are not single files.
        throw Object.assign(
          failed('unexpected_response', 'The path did not resolve to a single file.', {
            httpStatus: r.status,
            attempted: true,
          }),
          { request: { method: 'GET', path, attempted: true } },
        );
      }
      const data = { truncated: Boolean(c.truncated) };
      if (c.path != null) data.path = c.path;
      if (c.sha != null) data.sha = c.sha;
      if (c.size != null) data.size = c.size;
      if (c.encoding != null) data.encoding = c.encoding;
      if (c.content != null) data.content = c.content;
      return success({ method: 'GET', path, status: r.status, data });
    },
  },
];
