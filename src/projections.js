// Read projections (spec §6).
//
// Every read output uses only the defined fields for its resource type. An
// optional field is omitted when the source is absent; omitted values are
// never fabricated. Source field names that differ from the projection name
// are mapped explicitly (for example a commit status's `status` becomes the
// projection's `state`, and a branch's `commit.id` becomes `commit_sha`).

function put(out, key, value) {
  if (value !== undefined && value !== null) out[key] = value;
  return out;
}

export function projectUser(u) {
  if (!u || typeof u !== 'object') return undefined;
  const out = {};
  put(out, 'id', u.id);
  put(out, 'login', u.login);
  put(out, 'full_name', u.full_name);
  put(out, 'html_url', u.html_url);
  return out;
}

export function projectRepository(r) {
  const out = {};
  put(out, 'id', r.id);
  put(out, 'full_name', r.full_name);
  put(out, 'description', r.description);
  put(out, 'private', r.private);
  put(out, 'archived', r.archived);
  put(out, 'default_branch', r.default_branch);
  put(out, 'html_url', r.html_url);
  return out;
}

export function projectBranch(b) {
  const out = {};
  put(out, 'name', b.name);
  put(out, 'protected', b.protected);
  put(out, 'commit_sha', b.commit?.id);
  return out;
}

export function projectLabel(l) {
  const out = {};
  put(out, 'id', l.id);
  put(out, 'name', l.name);
  put(out, 'color', l.color);
  put(out, 'description', l.description);
  return out;
}

export function projectMilestone(m) {
  const out = {};
  put(out, 'id', m.id);
  put(out, 'title', m.title);
  put(out, 'state', m.state);
  put(out, 'description', m.description);
  put(out, 'due_on', m.due_on);
  return out;
}

export function projectIssue(i, { detail = false } = {}) {
  const out = {};
  put(out, 'id', i.id);
  put(out, 'number', i.number);
  put(out, 'title', i.title);
  put(out, 'state', i.state);
  put(out, 'html_url', i.html_url);
  put(out, 'updated_at', i.updated_at);
  if (i.user) put(out, 'user', { login: i.user.login });
  if (Array.isArray(i.assignees)) {
    out.assignees = i.assignees.map((a) => ({ login: a.login }));
  }
  if (Array.isArray(i.labels)) {
    out.labels = i.labels.map((l) => ({ id: l.id, name: l.name }));
  }
  if (i.milestone) put(out, 'milestone', { id: i.milestone.id, title: i.milestone.title });
  out.is_pull_request = Boolean(i.pull_request);
  if (detail) put(out, 'body', i.body);
  return out;
}

export function projectComment(c) {
  const out = {};
  put(out, 'id', c.id);
  put(out, 'body', c.body);
  put(out, 'html_url', c.html_url);
  put(out, 'updated_at', c.updated_at);
  if (c.user) put(out, 'user', { login: c.user.login });
  return out;
}

export function projectPull(p, { detail = false } = {}) {
  const out = {};
  put(out, 'id', p.id);
  put(out, 'number', p.number);
  put(out, 'title', p.title);
  put(out, 'state', p.state);
  put(out, 'draft', p.draft);
  put(out, 'html_url', p.html_url);
  put(out, 'updated_at', p.updated_at);
  if (p.user) put(out, 'user', { login: p.user.login });
  if (p.base) out.base = compact({ ref: p.base.ref, sha: p.base.sha });
  if (p.head) out.head = compact({ ref: p.head.ref, sha: p.head.sha });
  put(out, 'mergeable', p.mergeable);
  put(out, 'merged', p.merged);
  put(out, 'merge_commit_sha', p.merge_commit_sha);
  if (detail) {
    put(out, 'body', p.body);
    put(out, 'changed_files', p.changed_files);
    put(out, 'additions', p.additions);
    put(out, 'deletions', p.deletions);
  }
  return out;
}

export function projectReview(r) {
  const out = {};
  put(out, 'id', r.id);
  put(out, 'state', r.state);
  put(out, 'body', r.body);
  put(out, 'commit_id', r.commit_id);
  if (r.user) put(out, 'user', { login: r.user.login });
  put(out, 'submitted_at', r.submitted_at);
  put(out, 'stale', r.stale);
  put(out, 'dismissed', r.dismissed);
  put(out, 'html_url', r.html_url);
  return out;
}

export function projectStatus(s) {
  const out = {};
  put(out, 'id', s.id);
  put(out, 'context', s.context);
  // Forgejo's CommitStatus carries the state under `status`.
  put(out, 'state', s.status ?? s.state);
  put(out, 'description', s.description);
  put(out, 'target_url', s.target_url);
  put(out, 'created_at', s.created_at);
  return out;
}

export function projectRun(r) {
  const out = {};
  put(out, 'id', r.id);
  put(out, 'index_in_repo', r.index_in_repo);
  put(out, 'workflow_id', r.workflow_id);
  put(out, 'title', r.title);
  put(out, 'commit_sha', r.commit_sha);
  put(out, 'status', r.status);
  put(out, 'html_url', r.html_url);
  put(out, 'created', r.created);
  put(out, 'updated', r.updated);
  return out;
}

export function projectJob(j) {
  const out = {};
  put(out, 'id', j.id);
  put(out, 'run_id', j.run_id);
  put(out, 'name', j.name);
  put(out, 'status', j.status);
  return out;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) put(out, k, v);
  return out;
}
