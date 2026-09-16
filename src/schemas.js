// Output data schemas, one per projected resource, and the shared envelope
// schema generator. The registry uses these both to validate the
// structuredContent it returns and to publish outputSchema in the manifest, so
// runtime output and the portable manifest cannot drift.

import { OUTCOMES, EFFECTS, VERIFICATIONS } from './constants.js';

function obj(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const intOrNull = { type: ['integer', 'null'] };
const boolOrNull = { type: ['boolean', 'null'] };
const login = obj({ login: str });

export const S = {};

S.user = obj({ id: int, login: str, full_name: str, html_url: str });

S.repository = obj({
  id: int,
  full_name: str,
  description: str,
  private: bool,
  archived: bool,
  default_branch: str,
  html_url: str,
});

S.branch = obj({ name: str, protected: bool, commit_sha: str });

S.label = obj({ id: int, name: str, color: str, description: str });

S.milestone = obj({ id: int, title: str, state: str, description: str, due_on: str });

S.issue = obj({
  id: int,
  number: int,
  title: str,
  state: str,
  html_url: str,
  updated_at: str,
  user: login,
  assignees: { type: 'array', items: login },
  labels: { type: 'array', items: obj({ id: int, name: str }) },
  milestone: obj({ id: int, title: str }),
  is_pull_request: bool,
  body: str,
});

S.comment = obj({ id: int, body: str, html_url: str, updated_at: str, user: login });

S.pull = obj({
  id: int,
  number: int,
  title: str,
  state: str,
  draft: bool,
  html_url: str,
  updated_at: str,
  user: login,
  base: obj({ ref: str, sha: str }),
  head: obj({ ref: str, sha: str }),
  mergeable: bool,
  merged: bool,
  merge_commit_sha: str,
  body: str,
  changed_files: int,
  additions: int,
  deletions: int,
});

S.review = obj({
  id: int,
  state: str,
  body: str,
  commit_id: str,
  user: login,
  submitted_at: str,
  stale: bool,
  dismissed: bool,
  html_url: str,
});

S.status = obj({ id: int, context: str, state: str, description: str, target_url: str, created_at: str });

S.run = obj({
  id: int,
  index_in_repo: int,
  workflow_id: str,
  title: str,
  commit_sha: str,
  status: str,
  html_url: str,
  created: str,
  updated: str,
});

S.job = obj({ id: int, run_id: int, name: str, status: str });

S.file = obj({
  path: str,
  sha: str,
  size: int,
  encoding: str,
  content: str,
  truncated: bool,
});

S.prFile = obj({
  filename: str,
  previous_filename: str,
  status: str,
  additions: int,
  deletions: int,
  changes: int,
});

S.diff = obj({ diff: str, truncated: bool });

// Small mutation-result shapes.
S.deleted = obj({ id: int, deleted: bool }, ['id', 'deleted']);
S.issueLabels = obj({ index: int, labels: { type: 'array', items: S.label } }, ['index', 'labels']);
S.merged = obj({ number: int, merged: bool, merge_commit_sha: str }, ['number', 'merged']);
S.dispatched = obj({ accepted: bool, run_id: int }, ['accepted']);
S.cancelled = obj({ run_id: int, accepted: bool }, ['run_id', 'accepted']);

/** An upstream-paged list of `item`. */
export function paged(item) {
  return obj(
    {
      items: { type: 'array', items: item },
      count: int,
      page: int,
      limit: int,
      next_page: intOrNull,
      has_more: boolOrNull,
      truncated: bool,
      total: int,
    },
    ['items', 'count', 'page', 'limit', 'next_page', 'truncated'],
  );
}

/** A locally-windowed list of `item`. */
export function windowed(item) {
  return obj(
    {
      items: { type: 'array', items: item },
      count: int,
      offset: int,
      limit: int,
      next_offset: intOrNull,
      total: int,
      truncated: bool,
    },
    ['items', 'count', 'offset', 'limit', 'next_offset', 'truncated'],
  );
}

/** Wrap a data schema in the full result-envelope schema. */
export function envelopeSchema(dataSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'effect', 'request', 'verification'],
    properties: {
      outcome: { enum: [...OUTCOMES] },
      effect: { enum: [...EFFECTS] },
      request: obj({ method: str, path: str, attempted: bool }, ['method', 'path', 'attempted']),
      verification: { enum: [...VERIFICATIONS] },
      http_status: int,
      data: dataSchema ?? {},
      reason: str,
      message: str,
      evidence: { type: 'object' },
    },
  };
}
