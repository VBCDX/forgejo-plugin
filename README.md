# @vbcdx/forgejo-plugin

An [MCP](https://modelcontextprotocol.io) server for [Forgejo](https://forgejo.org). It gives AI
agents a fixed set of 35 tools for repositories, issues, comments, labels, milestones, pull
requests, reviews, commit statuses and Actions runs, with a write gate and verified results.

- Runs over **stdio** (for a local agent harness) or **Streamable HTTP** (as a network service or
  container).
- **Write gate:** reads only by default. Writes and destructive operations need explicit opt-in.
- **Verified results:** writes are read back to confirm them, and a timed-out or ambiguous write
  is reported as such rather than as success or failure. `dispatch_workflow` and
  `cancel_workflow_run` are acknowledged only (outcome `accepted`); the run itself is not awaited.

The full specification is in [docs/contract.md](docs/contract.md).

## Requirements

- Node.js 22 or later
- A Forgejo instance and an access token (or username and password) for it

## Install

```sh
npm install -g @vbcdx/forgejo-plugin
```

This installs the `vbcdx-forgejo` command. To run it without installing:

```sh
npx -y --package=@vbcdx/forgejo-plugin vbcdx-forgejo --help
```

## Usage

```text
vbcdx-forgejo mcp          Start the stdio MCP server (default)
vbcdx-forgejo serve        Start the network MCP server (Streamable HTTP)
vbcdx-forgejo healthcheck  Probe a running serve endpoint; exit 0 if healthy
vbcdx-forgejo manifest     Print the JSON tool manifest
vbcdx-forgejo --help
vbcdx-forgejo --version
```

### Register with an MCP client

Claude Code:

```sh
claude mcp add forgejo --scope user \
  -e VBCDX_FORGEJO_URL=https://git.example.com \
  -e VBCDX_FORGEJO_WRITES=off \
  -- vbcdx-forgejo mcp
```

Codex:

```sh
codex mcp add forgejo \
  --env VBCDX_FORGEJO_URL=https://git.example.com \
  --env VBCDX_FORGEJO_WRITES=off \
  -- vbcdx-forgejo mcp
```

For OpenCode, see [examples/opencode.json](examples/opencode.json). More detail is in
[examples/registration.md](examples/registration.md).

The package also ships a [`vbcdx.json`](vbcdx.json) declaration, so the
[vbcdx installer](https://github.com/VBCDX/vbcdx) can register it for you:

```sh
npm install -g @vbcdx/vbcdx
vbcdx install tool @vbcdx/forgejo-plugin --harness=claude
```

## Configuration

Settings are read from the environment once, at startup. See [.env.example](.env.example).

| Variable | Default | Description |
| --- | --- | --- |
| `VBCDX_FORGEJO_URL` | none | Forgejo instance URL, optionally ending in `/api/v1`. Required for any call. |
| `VBCDX_FORGEJO_WRITES` | `off` | `off` (reads only), `write` (ordinary writes), or `full` (also destructive tools). |
| `VBCDX_FORGEJO_TIMEOUT_MS` | `30000` | Total deadline per tool call, 1000 to 120000 ms. |

Tools are always listed. A call made without valid configuration or credentials returns an error
explaining what is missing.

### Credentials (stdio mode)

Credentials are never passed on the command line or in the environment. Every tool takes a
`credential_file` argument: the absolute path to a file like this:

```sh
VBCDX_AGENTS_ROLE=code-agent
VBCDX_AGENTS_USER=example-bot
VBCDX_AGENTS_TOKEN=<forgejo access token>
# VBCDX_AGENTS_PASSWORD=<optional, used once if the token is rejected with 401>
```

The file must be a regular file you own with mode `0600`, in a directory with mode `0700`:

```sh
install -d -m 0700 ~/.config/vbcdx/forgejo
install -m 0600 /dev/null ~/.config/vbcdx/forgejo/code-agent.env
```

See [examples/credential-file.env](examples/credential-file.env) for the full format.

## Network mode

`vbcdx-forgejo serve` exposes the same tools over MCP Streamable HTTP:

```sh
VBCDX_FORGEJO_URL=https://git.example.com vbcdx-forgejo serve
# MCP endpoint: POST http://127.0.0.1:8080/mcp
# Liveness:     GET  http://127.0.0.1:8080/healthz
```

In this mode there is no credential file. Each request carries its own credential in the
`Authorization` header (`Bearer <token>`, `token <token>`, or `Basic <base64(user:password)>`),
which is used for that request only.

| Variable | Default | Description |
| --- | --- | --- |
| `VBCDX_FORGEJO_HTTP_PORT` | `8080` | Listen port. |
| `VBCDX_FORGEJO_HTTP_HOST` | `127.0.0.1` | Bind address. |
| `VBCDX_FORGEJO_TLS_CERT` | none | PEM certificate path. Set together with the key to serve HTTPS. |
| `VBCDX_FORGEJO_TLS_KEY` | none | PEM private key path. |
| `VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call the server. Requests with any other `Origin` header get `403`. |

Without TLS settings the server speaks plain HTTP; run it behind a TLS-terminating reverse proxy or
on a trusted network. Outbound connections to Forgejo always verify TLS.

### Docker

```sh
docker build -t vbcdx-forgejo .
docker run --rm -p 8080:8080 \
  -e VBCDX_FORGEJO_URL=https://git.example.com \
  vbcdx-forgejo
```

The image runs `serve` as a non-root user and listens on all interfaces. No credentials are stored
in the image.

## Tools

Run `vbcdx-forgejo manifest` for every tool's input and output schema.

| Effect | Tools |
| --- | --- |
| Read | `whoami`, `list_repositories`, `get_repository`, `list_branches`, `get_file`, `list_issues`, `get_issue`, `list_comments`, `get_comment`, `list_labels`, `list_milestones`, `list_pull_requests`, `get_pull_request`, `get_pull_request_diff`, `list_pull_request_files`, `list_reviews`, `get_review`, `list_commit_statuses`, `list_workflow_runs`, `get_workflow_run`, `list_workflow_jobs` |
| Write (`write` or `full`) | `create_repository`, `create_issue`, `update_issue`, `set_issue_labels`, `create_comment`, `update_comment`, `create_pull_request`, `update_pull_request`, `create_review`, `set_commit_status`, `dispatch_workflow` |
| Destructive (`full` only) | `delete_comment`, `merge_pull_request`, `cancel_workflow_run` |

Destructive tools also require an exact confirmation string naming the target, and edits to
comments or pull requests check the expected current state (a body hash or head SHA) first.

`list_reviews` caps each review body at 2000 characters by default (`body_max_chars`) and can
filter by `commit_id` and `state`; use `get_review` to read one review in full.

### Results

Each call returns a text summary and a JSON envelope in `structuredContent` with `outcome`,
`effect`, `request` and `verification`. The outcome is one of `ok`, `accepted`, `refused`,
`failed`, `unverified` or `indeterminate`.

## Development

```sh
npm ci
npm test
node bin/vbcdx-forgejo.js --help
```

## License

[MIT](LICENSE)
