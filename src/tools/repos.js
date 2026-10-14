// Repositories: organisation repo listing, single repo, branches, file, and
// creating a repository in an organisation.

import {
  getJson,
  inputSchema,
  ownerRepo,
  pageLimit,
  pagedEnvelope,
  resolvePage,
  resolveLimit,
  success,
  unverifiedSpec,
  verifyGet,
} from '../toolkit.js';
import { envelopeSchema, S, paged } from '../schemas.js';
import { projectRepository, projectBranch } from '../projections.js';
import { failed, refused } from '../errors.js';

const seg = encodeURIComponent;

const orgName = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\s/\\\\.][^\\s/\\\\]*$' };
// Forgejo repository names: letters, digits, '-', '_', '.'; the first character is
// not '.', which also rules out '.' and '..'.
const repoName = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' };
const branchName = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9._/-]+$' };

/** First requested field the read-back repository does not match, or null. */
function compareRepository(requested, got) {
  if (!got || typeof got !== 'object') return 'response';
  if (typeof got.owner?.login !== 'string' || got.owner.login.toLowerCase() !== requested.org.toLowerCase()) return 'owner';
  if (typeof got.name !== 'string' || got.name.toLowerCase() !== requested.name.toLowerCase()) return 'name';
  if (got.private !== requested.private) return 'visibility';
  if (requested.description !== undefined && (got.description ?? '') !== requested.description) return 'description';
  if (requested.default_branch !== undefined && got.default_branch !== requested.default_branch) return 'default branch';
  return null;
}

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
        org: orgName,
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
  {
    name: 'create_repository',
    description:
      'Create a repository in an organisation, then read it back to verify name, visibility, description and default branch. ' +
      'Visibility is explicit (private is required). default_branch needs auto_init (Forgejo ignores it otherwise). ' +
      'Needs a token with write:organization (the create) and read:repository (the read-back that confirms it), ' +
      'and permission to create repositories in the organisation.',
    effect: 'write',
    // The read-back is a /repos/* route, which write:organization does not
    // grant (measured on Forgejo 16: a 403 naming read:repository).
    // Without it every create would end unverified/unavailable.
    permissions: ['write:organization', 'read:repository'],
    method: 'POST',
    route: '/orgs/{org}/repos',
    input: inputSchema({
      properties: {
        org: orgName,
        name: repoName,
        private: { type: 'boolean' },
        description: { type: 'string', maxLength: 2048 },
        auto_init: { type: 'boolean' },
        default_branch: branchName,
      },
      required: ['org', 'name', 'private'],
    }),
    output: envelopeSchema(S.repository),
    async run({ args, call, auth }) {
      // Forgejo only applies default_branch when it initialises the repository;
      // accepting it otherwise would report a branch that was never set.
      if (args.default_branch !== undefined && args.auto_init !== true) {
        throw refused('validation_failed', 'default_branch requires auto_init: true (Forgejo ignores it otherwise).');
      }
      const path = `/orgs/${seg(args.org)}/repos`;
      const body = { name: args.name, private: args.private };
      if (args.description !== undefined) body.description = args.description;
      if (args.auto_init !== undefined) body.auto_init = args.auto_init;
      if (args.default_branch !== undefined) body.default_branch = args.default_branch;

      const r = await getJson(call, 'mutation', { method: 'POST', path, body, auth });
      // Verify where it was asked to be, never where the response says it is:
      // read back at the requested org/name (Forgejo resolves names
      // case-insensitively) and require the owner to be that org.
      const check = await verifyGet(call, { method: 'GET', path: `/repos/${seg(args.org)}/${seg(args.name)}`, auth });
      if (!check.ok) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, message: 'The repository was created but could not be read back to confirm.', evidence: { full_name: `${args.org}/${args.name}` } });
      }
      const mismatch = compareRepository(
        { org: args.org, name: args.name, private: args.private, description: args.description, default_branch: args.default_branch },
        check.json,
      );
      if (mismatch) {
        return unverifiedSpec({ method: 'POST', path, status: r.status, verification: 'mismatch', message: `The created repository's ${mismatch} did not match what was requested.`, evidence: { full_name: check.json?.full_name } });
      }
      return success({ outcome: 'ok', method: 'POST', path, status: r.status, verification: 'confirmed', data: projectRepository(check.json) });
    },
  },
];
