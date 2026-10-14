# Contract `vbcdx.forgejo/1`: the Forgejo MCP server

This document specifies `@vbcdx/forgejo-plugin`: its commands, configuration, credential
handling, tool catalog, results and manifest. Where the README disagrees with it, this document
wins.

The credential-file grammar is shared with the [vbcdx installer](https://github.com/VBCDX/vbcdx),
which writes those files; agent bindings are the installer's too. This document owns the Forgejo
server, its service configuration, tool API and authentication behavior.

## 1. Deliverable and exclusions

`@vbcdx/forgejo-plugin` is an ES-module Node.js package (Node 22 or later) with the executable `vbcdx-forgejo` (`bin/vbcdx-forgejo.js`). It ships runnable JavaScript with no build step, and the MCP SDK version is pinned. The package installs no agents and provisions no credentials or Forgejo accounts.

Commands:

* `vbcdx-forgejo mcp`: stdio MCP server. No secret, URL, role-selector or credential-path CLI arguments.
* `vbcdx-forgejo serve`: the same catalog as an MCP server over Streamable HTTP (section 3), credentials per request by header (section 4).
* `vbcdx-forgejo healthcheck`: probe a locally running `serve` endpoint; exit 0 when healthy, 1 otherwise.
* `vbcdx-forgejo manifest`: deterministic JSON tool manifest for the agents installer, with no network/file-secret access or server startup.
* `vbcdx-forgejo --help` and `--version`: print help/version and exit. Unknown commands/options exit 2.

`mcp` supports initialization, tool discovery and calls using a maintained MCP SDK and its supported negotiated protocol versions. Only protocol frames go to stdout; redacted diagnostics go to stderr. EOF, SIGTERM and cancellation clean up in-flight work. Tools remain discoverable without credentials or with invalid service configuration; calls return actionable errors. Malformed protocol messages use protocol errors; expected tool/input/upstream failures use tool results with `isError: true`.

The finite v1 catalog is section 6. The package does not include a generic API proxy, shell/curl wrapper, env reader, local workdir creation/deletion, Git credential helper, browser-cookie/CSRF login, runner administration, deploy-key/webhook administration, repository deletion or arbitrary file writes. Forgejo's API has no CI re-run route, so neither does this package.

## 2. Installation and harness registration

Use distinct MCP server identity `forgejo`; the Coolify package uses `coolify`. Raw tool names are
the unprefixed snake_case names in section 6; each harness adds its own prefix (`mcp__forgejo__<name>`
in Claude Code, `forgejo_<name>` in OpenCode).

**With the vbcdx installer.** The package ships `vbcdx.json`, the declaration
`vbcdx install tool` reads: the server name, the `mcp` launch, the settings it reads (with the run
modes that read them; section 3) and the per-call `credential_file` argument. One command
registers the server for Claude Code, Codex, OpenCode or Hermes Agent, and `vbcdx install agent`
binds each role to the tools its reviewed allowlist permits:

```sh
vbcdx install tool @vbcdx/forgejo-plugin --harness=claude
vbcdx install agent review-agent --harness=claude
```

**By hand.** Register `node <installed package>/bin/vbcdx-forgejo.js mcp` (or the `vbcdx-forgejo`
binary) as a stdio server with the harness's own command, passing `VBCDX_FORGEJO_URL` and
`VBCDX_FORGEJO_WRITES` in its environment. For example, Claude Code (the default scope is local,
so name one):

```sh
claude mcp add forgejo --scope user \
  -e VBCDX_FORGEJO_URL=https://git.example.com \
  -e VBCDX_FORGEJO_WRITES=off \
  -- node /absolute/package/bin/vbcdx-forgejo.js mcp
```

Codex: `codex mcp add forgejo --env VBCDX_FORGEJO_URL=… --env VBCDX_FORGEJO_WRITES=off -- node …/vbcdx-forgejo.js mcp`
writes `[mcp_servers.forgejo]` in `$CODEX_HOME/config.toml`. OpenCode: a `mcp.forgejo` entry of
`"type": "local"` with `"command": ["node", "…/vbcdx-forgejo.js", "mcp"]` and the two settings in
`"environment"`, in the operator's chosen configuration root. OpenCode's MCP `timeout` concerns
tool discovery; do not take it for the operation deadline.

Production setups pin an immutable artifact (a published version, or a reviewed commit); do not
fetch a moving branch at every launch. The package never edits the installer's configuration or
another server's entry.

## 3. Launch configuration and transport safeguards

Only these service settings affect the server: `VBCDX_FORGEJO_URL` (required for a call), `VBCDX_FORGEJO_WRITES` (`off` default, `write`, `full`), and `VBCDX_FORGEJO_TIMEOUT_MS` (integer total-call deadline, default 30000, range 1000–120000). Read once per process; maintain independent configuration per instance. No `CODE_HOST_*`, `FORGEJO_AGENT`, ambient token/password or `VBCDX_AGENTS_*` launch-secret fallback.

URL is the instance origin with optional deployment subpath, optionally ending in `/api/v1`; normalize trailing slashes and append the API suffix exactly once. Accept HTTP(S), reject userinfo, query, fragment, NUL/control characters and malformed paths. HTTP can serve an explicitly configured trusted local network; report its unencrypted nature once without printing any secret. Construct and encode route segments/query values; no caller-supplied absolute target URL, `..` path escape or off-origin request. Reject redirects rather than forwarding credentials. Never disable TLS verification.

Invalid URL/deadline settings cause a configuration tool error before network access; invalid write mode behaves as off and reports the invalid setting on a write call. Never echo an unvalidated configuration value that might contain a secret. A missing configuration does not prevent MCP initialization/tools/list.

One deadline covers credential loading, optional preflight, primary request, pagination and verification. Propagate cancellation, limit response bodies to 2 MiB before parsing, and keep rendered results within 256 KiB with explicit truncation for permitted text/list content. JSON that cannot be parsed within bounds is an error, not an empty success. No automatic transport retries in v1; the specifically defined 401 authentication fallback is the sole exception. Do not retry a possibly applied mutation after timeout, reset, 5xx or malformed success response. Configure each harness's call deadline above the server deadline, or lower the server deadline; test actual behavior instead of inferring it from a discovery timeout.

`serve` (network mode) also reads these settings, which no stdio entry carries (`vbcdx.json` marks
them `"modes": ["http"]`):

* `VBCDX_FORGEJO_HTTP_PORT`: listen port, default 8080.
* `VBCDX_FORGEJO_HTTP_HOST`: bind address, default `127.0.0.1` (loopback only); the container image sets `0.0.0.0`.
* `VBCDX_FORGEJO_TLS_CERT` and `VBCDX_FORGEJO_TLS_KEY`: PEM paths to serve HTTPS directly; both or neither. Otherwise plain HTTP, for use behind a TLS-terminating proxy or on a trusted local network, which `serve` logs at startup.
* `VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS`: comma-separated browser origins (`scheme://host[:port]`, no wildcards). A request carrying any other `Origin` is refused with 403 (DNS-rebinding protection); server-to-server clients send none. An invalid entry stops `serve` at startup.

`serve` exposes `POST /mcp` (Streamable HTTP) and `GET /healthz`. A setting whose value is exactly an
unexpanded reference such as `${VBCDX_FORGEJO_TIMEOUT_MS}` counts as unset, because some harnesses
pass a reference to an unset variable through as text. `VBCDX_FORGEJO_TLS_CERT`,
`VBCDX_FORGEJO_TLS_KEY` and `VBCDX_FORGEJO_HTTP_HOST` are the exceptions: an unexpanded value there
stops `serve` with an error naming the setting, rather than falling back to cleartext or a wider bind.
The outbound connection to Forgejo always verifies TLS.

## 4. Credential file and authentication

Every catalog tool requires `credential_file`, an absolute path. Read exactly that file for each call. Never search, select a role, borrow another file, accept a token in tool arguments, or cache credential values between calls. The literal grammar and quoting are the installer's: no sourcing/expansion, duplicate rejection, lossless quoted values, and literal dollar signs. Require a regular nonsymlink file owned by the effective user at mode 0600, with its private immediate parent at 0700 and no symlink path components; handle file replacement safely. v1 is POSIX; other platforms are unsupported until equivalent protection is tested, rather than silently skipping checks.

Fields: `VBCDX_AGENTS_ROLE` identifies the file's canonical role; `VBCDX_AGENTS_USER` is required by this Forgejo file contract; at least one of `VBCDX_AGENTS_TOKEN` and `VBCDX_AGENTS_PASSWORD` must be nonblank. ROLE is descriptive, never authorization. Reject malformed known fields and unsupported `VBCDX_AGENTS_*` credential fields; do not output ignored unrelated values. A Coolify token file is not a Forgejo credential even though the grammar is shared.

Use `Authorization: token <token>` when TOKEN is present. Forgejo's token-header API does not generally require a separate username; USER is retained for the shared role-file contract and Basic fallback. If token is absent, use USER/PASSWORD Basic authentication when present. If a token request receives an explicit 401, retry that request once with the same file's USER/PASSWORD; never on 403, redirects, network ambiguity, 429 or 5xx. Reuse the resulting authentication choice only within that tool call. A second 401 is final. Credentials never enter URLs, command arguments, manifests, logs or returned data.

Missing/unsafe/malformed file errors include the attempted absolute path, relevant key names and required literal format/mode, never actual values. Example:

```text
Credential file not found: /home/example/.config/vbcdx/forgejo/code-agent.env.
Expected a regular owned file, mode 0600, in a private 0700 directory:
VBCDX_AGENTS_ROLE=code-agent
VBCDX_AGENTS_USER=<username>
VBCDX_AGENTS_TOKEN=<token>
VBCDX_AGENTS_PASSWORD=<optional password>
At least one token/password is required. No Forgejo request was attempted.
```

Failures use fixed reasons: `credential_missing`, `credential_not_absolute`, `credential_unreadable`, `credential_unsafe`, `credential_malformed`, `credential_key_missing`, `credential_rejected` or `permission_denied`. Safely escape paths in text; do not include raw OS buffers, upstream bodies or authorization headers. A 403 reports required endpoint permissions without assuming every 403 has the same cause.

In `serve` there is no credential file and no `credential_file` argument. Each request carries one
credential in its `Authorization` header: `Bearer <token>` or `token <token>` (forwarded upstream as
Forgejo's `token` scheme), or `Basic <base64(user:password)>` (forwarded as is). It is used for that
request only and never cached. The token→Basic retry after a 401 is a credential-file feature and
does not apply. Discovery works without a credential; a call without one returns an actionable,
redacted error. Credentials are never read from the environment in either mode.

## 5. Effects, output and verification

Every tool declares `read`, `write` or `destructive` in its registry and manifest, with matching MCP annotations. Reads perform GET only. Write mode off refuses writes; write allows ordinary writes; full also allows destructive tools with exact target confirmation. All tools remain discoverable. The gate executes before credential reads/network requests and cannot be bypassed through aliases or helper calls. It is an accident control, not a human-approval or identity boundary. Native tool permissions, OS isolation, Forgejo token scopes/repository permissions and branch protection provide the actual controls. The server cannot guarantee independent reviewers or prevent self-approval using an identity with sufficient authority.

Every call returns one complete human-readable text result plus the same JSON envelope in `structuredContent`, validated against its `outputSchema`:

```json
{
  "outcome": "ok",
  "effect": "read",
  "request": {"method":"GET","path":"/api/v1/user","attempted":true},
  "http_status":200,
  "verification":"not_applicable",
  "data":{"id":1,"login":"example"}
}
```

Required fields are outcome, effect, request and verification. `http_status` exists only when received; `data` is present only for ok/accepted. Failure adds required `reason` and `message`; optional redacted `evidence` can identify observed resource IDs, preflight/read-back status and partial effects. Never put resource-shaped success data on a failure. `request.attempted` concerns the primary operation, not a preceding preflight; messages explicitly distinguish a failed preflight from “no HTTP request.” It means dispatch was attempted, not proof bytes reached the server.

Outcomes: `ok` (read, or verified synchronous mutation); `accepted` (asynchronous work acknowledged, not complete); `refused` (local validation/config/credential/gate failure before network); `failed` (read failure, preflight failure or explicit rejected operation); `unverified` (successful mutation response but observable state could not be confirmed); `indeterminate` (mutation may have applied, including malformed 2xx, timeout/reset or ambiguous 5xx). Only ok/accepted have `isError: false`. Verification is `not_applicable`, `confirmed`, `pending`, `unavailable` or `mismatch` as appropriate. Do not turn a timeout into “nothing changed.”

Additional reasons: `validation_failed`, `server_not_configured`, `write_gate_disabled`, `confirmation_required`, `confirmation_mismatch`, `not_found`, `conflict`, `rate_limited`, `upstream_error`, `network_error`, `timeout`, `response_too_large`, `unexpected_response`, `verification_failed`, `indeterminate_write`, `unsupported_operation`. Preserve safe HTTP status and Retry-After metadata, not arbitrary response messages.

For synchronous creates/edits, GET the resulting resource and compare only fields requested by this call plus identity; do not claim an entire object matches. A 204 is legitimate where documented, followed by verification when applicable. Missing/inaccessible/mismatched verification produces unverified and states the operation may already have happened. Comments/body text round-trip literally, including final newlines. Before changing an existing resource, GET it when required below and check the provided expected revision/digest; preflight is advisory unless the upstream endpoint offers an atomic condition. Document the remaining race rather than inventing compare-and-swap support.

## 6. Exact v1 tool catalog

Notation: all rows additionally require `credential_file`. `R` = required string owner/repo pair. `index`, `id`, `run_id`, label/milestone IDs are positive integers. `?` = optional. Text is UTF-8; nonempty identifiers reject controls, separators where inappropriate and traversal. `sha`/expected commit values are full 40- or 64-character lowercase hex strings. `page?` defaults 1; `limit?` defaults 25, range 1–50. expected_body_sha256 is exactly 64 lowercase hex characters. Review event APPROVED is Forgejo's enum; the GitHub-style APPROVE is invalid. Bodies/messages preserve whitespace and line endings; max input body is 128 KiB. Unknown inputs are rejected. URL fields accept HTTP(S) without userinfo. Required scope labels below describe Forgejo access-token scope families; repository membership, units and protection rules still apply.

Read outputs use only these defined projections, optional fields omitted when absent; omitted values are not fabricated:

* User: `id, login, full_name, html_url`.
* Repository: `id, full_name, description, private, archived, default_branch, html_url`.
* Branch: `name, protected, commit_sha` (from commit.id).
* Issue: `id, number, title, state, html_url, updated_at, user.login, assignees[].login, labels[].{id,name}, milestone.{id,title}, is_pull_request`; detail additionally body.
* Comment: `id, body, html_url, updated_at, user.login`.
* PR: `id, number, title, state, draft, html_url, updated_at, user.login, base.{ref,sha}, head.{ref,sha}, mergeable, merged, merge_commit_sha`; detail additionally body and changed_files/additions/deletions.
* Review: `id, state, body, commit_id, user.login, submitted_at, stale, dismissed, html_url`.
* Label: `id, name, color, description`; Milestone: `id, title, state, description, due_on`.
* Status: `id, context, state, description, target_url, created_at`; use documented source field mappings.
* Run: `id, index_in_repo, workflow_id, title, commit_sha, status, html_url, created, updated`; Job: `id, run_id, name, status`.

| Tool | Additional input | API operation / data | Effect; token scope |
| --- | --- | --- | --- |
| `whoami` | none | GET `/user` → User | read; read:user |
| `list_repositories` | `org`, page?, limit? | GET `/orgs/{org}/repos` → page of Repository | read; read:organization |
| `get_repository` | R | GET `/repos/{owner}/{repo}` → Repository | read; read:repository |
| `list_branches` | R, page?, limit? | GET `/repos/{owner}/{repo}/branches` → page of Branch | read; read:repository |
| `create_repository` | `org`, `name`, `private` boolean, description?, auto_init?, default_branch? (needs auto_init) | POST `/orgs/{org}/repos`; read back at `/repos/{org}/{name}` and compare name, visibility, description and default branch → verified Repository | write; write:organization, read:repository |
| `get_file` | R, `path`, `ref` | GET `/repos/{owner}/{repo}/contents/{path}?ref=...` → `{path,sha,size,encoding,content,truncated}`; file only, decode UTF-8 text or keep explicit base64 | read; read:repository |
| `list_issues` | R, state?=`open`, labels? string[], q?, page?, limit? | GET `/repos/{owner}/{repo}/issues`, force `type=issues` → page of Issue | read; read:issue |
| `get_issue` | R, index | GET `/repos/{owner}/{repo}/issues/{index}` → Issue detail | read; read:issue |
| `create_issue` | R, `title`, body?, assignees? string[], labels? integer[], milestone? integer | POST `/repos/{owner}/{repo}/issues` → verified Issue detail | write; write:issue |
| `update_issue` | R, index, title?, body?, state?=`open\|closed`, assignees? string[], milestone? integer-or-null, expected_updated_at? | PATCH same issue; at least one change; null milestone maps to 0 to clear → verified Issue detail | write; write:issue |
| `list_comments` | R, index, offset?=0, limit? | GET `/repos/{owner}/{repo}/issues/{index}/comments` → local window of Comment | read; read:issue |
| `get_comment` | R, id | GET `/repos/{owner}/{repo}/issues/comments/{id}` → Comment | read; read:issue |
| `create_comment` | R, index, `body` | POST issue comments → verified Comment | write; write:issue |
| `update_comment` | R, id, `body`, `expected_body_sha256` | GET then PATCH comment if current body SHA256 matches; read-back exact new body → Comment | write; write:issue |
| `delete_comment` | R, id, `expected_body_sha256`, `confirm` | GET/digest then DELETE comment; verify absence → `{id,deleted:true}` | destructive; write:issue |
| `list_labels` | R, page?, limit? | GET repository labels → page of Label | read; read:issue |
| `set_issue_labels` | R, index, `labels` integer[], expected_labels? integer[] | GET then PUT issue labels (empty clears); compare unordered sets → `{index,labels:Label[]}` | write; write:issue |
| `list_milestones` | R, state?=`open`, page?, limit? | GET repository milestones → page of Milestone | read; read:issue |
| `list_pull_requests` | R, state?=`open`, base?, head?, page?, limit? | GET `/repos/{owner}/{repo}/pulls` → page of PR | read; read:repository |
| `get_pull_request` | R, index | GET pull → PR detail | read; read:repository |
| `list_pull_request_files` | R, index, page?, limit? | GET pull `/files` → page of `{filename,previous_filename,status,additions,deletions,changes}` | read; read:repository |
| `get_pull_request_diff` | R, index | GET `/repos/{owner}/{repo}/pulls/{index}.diff` → `{diff,truncated}` | read; read:repository |
| `create_pull_request` | R, `head`, `base`, `title`, body?, assignees? string[], labels? integer[], milestone? integer | POST pull → verified PR detail | write; write:repository |
| `update_pull_request` | R, index, title?, body?, state?=`open\|closed`, base?, assignees? string[], labels? integer[], `expected_head_sha` | GET/head check, PATCH allowed supplied fields only → verified PR detail | write; write:repository |
| `list_reviews` | R, index, commit_id?, state?, body_max_chars?=2000, page?, limit? | GET pull `/reviews` → page of Review, each body capped at body_max_chars (marked `body_truncated`); commit_id (full SHA or a prefix of 7+) and state filter locally | read; read:repository |
| `get_review` | R, index, id | GET pull `/reviews/{id}` → Review with its full body | read; read:repository |
| `create_review` | R, index, `expected_head_sha`, `event`=`COMMENT\|APPROVED\|REQUEST_CHANGES`, `body` | GET/head check then POST pull `/reviews`, map expected SHA to `commit_id`; list/read review verifies target → Review | write; write:repository |
| `merge_pull_request` | R, index, `expected_head_sha`, `method`=`merge\|rebase\|rebase-merge\|squash\|fast-forward-only`, `confirm` | GET/head check then POST pull `/merge`; send `head_commit_id`, `Do`, force_merge=false, merge_when_checks_succeed=false, delete_branch_after_merge=false; read PR verifies merged/head → `{number,merged:true,merge_commit_sha}` | destructive; write:repository |
| `list_commit_statuses` | R, `sha`, page?, limit? | GET `/repos/{owner}/{repo}/statuses/{sha}` → page of Status | read; read:repository |
| `set_commit_status` | R, `sha`, `state`=`pending\|success\|error\|failure\|warning`, `context`, description?, target_url? | POST statuses; read result/latest context status verifies requested SHA/context/state → Status | write; write:repository |
| `list_workflow_runs` | R, head_sha?, ref?, workflow_id?, page?, limit? | GET `/repos/{owner}/{repo}/actions/runs` → page of Run; unwrap documented workflow_runs/total_count | read; read:repository |
| `get_workflow_run` | R, run_id | GET `/repos/{owner}/{repo}/actions/runs/{run_id}` → Run | read; read:repository |
| `list_workflow_jobs` | R, run_id, offset?=0, limit? | GET run `/jobs` → local window of Job | read; read:repository |
| `dispatch_workflow` | R, `workflow` filename, `ref`, inputs? object<string,string> | POST `/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`; `return_run_info=true`; valid acknowledgement → `{accepted:true,run_id?}` | write; write:repository |
| `cancel_workflow_run` | R, run_id, `confirm` | POST run `/cancel` → `{run_id,accepted:true}`; cancellation not assumed complete | destructive; write:repository |

There are 35 tools. Admin operations, repository deletion and local workspace operations remain excluded; repository creation is limited to `create_repository` in an organisation. `expected_updated_at` and preflight hashes prevent accidental stale edits but cannot eliminate races without upstream atomic support. The merge endpoint's `head_commit_id` supplies its actual atomic head check; never replace it with a preflight alone. Never force merge or mark checks/reviews as satisfied based on a caller's claim. Setting a status reports the supplied verdict; the server does not itself perform the audit.

Confirm strings, exact after outer trim: `delete comment <owner>/<repo>#<id>`, `merge pull request <owner>/<repo>#<index> at <expected_head_sha>`, and `cancel workflow run <owner>/<repo>#<run_id>`. Confirmations do not constitute human approval. Do not send them to the upstream API.

For upstream-paged endpoints return `{items,count,page,limit,next_page,has_more,truncated,total?}`. `count` is returned items. `next_page` is an integer or null; `has_more` may be null if unknown. Follow documented Link/total metadata after validating origin, or offer the next page as a probe when a nonempty page lacks authoritative pagination metadata. Never infer completion from a short page alone: the host may clamp limits. Empty terminal pages establish completion. Do not silently auto-fetch all pages or stop at an undisclosed cap. For unpaged comments/jobs use local `{items,count,offset,limit,next_offset,total,truncated}` after bounded retrieval of the upstream array/wrapper. JSON body limit failures report `response_too_large` rather than pretending to page an incompletely parsed document. Text outputs cap at 64 KiB and mark truncation; never truncate mutation inputs silently.

## 7. Manifest and declaration

`manifest` emits a JSON object with exactly `schema_version:1`, `service:"forgejo"`, `contract:"vbcdx.forgejo/1"`,
`package_version`, and `tools`. Each tools entry contains `name`, `description`, `inputSchema`,
`outputSchema`, `effect`, `required_permissions` (string array). Entries are sorted by name and
serialized deterministically. The same registry generates the runtime schemas, effect checks and the
manifest, so they cannot drift.

`vbcdx.json` at the package root declares the server for the vbcdx installer: `server_name` `forgejo`,
`contract` `vbcdx.forgejo/1`, the `mcp` stdio launch, the `serve` http mode with its port setting,
every setting the server reads with its run modes, the `credential_file` argument, and the manifest
command. `vbcdx install tool` validates it, runs the manifest, and binds roles by contract. The
manifest proves an offline interface; a real MCP `tools/list` and call verify the registration.

## Sources

[Forgejo API usage](https://forgejo.org/docs/latest/user/api/usage/),
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[Claude Code MCP](https://code.claude.com/docs/en/mcp), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/).
