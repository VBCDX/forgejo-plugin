# @vbcdx/forgejo-plugin

An MCP server that exposes a **finite, verified Forgejo tool catalog** — contract
`vbcdx.forgejo/1`. It is a thin, auditable bridge: 33 tools covering users,
repositories, issues, comments, labels/milestones, pull requests, reviews,
commit statuses and Actions runs. It installs no agents and provisions no
credentials or Forgejo accounts.

> The **authoritative specification** is the contract `vbcdx.forgejo/1`; where
> anything here disagrees with it, the spec wins. This file covers what the
> package needs to be installed and run.

## Install & run

Requires Node.js ≥ 22. The package ships runnable JavaScript with no build step.

> **Not published yet.** This package is not on any public npm registry, so
> `npm install @vbcdx/forgejo-plugin` does not resolve today. The commands below
> are the intended install and invocation path once `0.1.0` is published and
> tested. To run it before then, use the [contributor commands](#running-from-a-checkout).

Once published, install the package and invoke the `vbcdx-forgejo` binary:

```sh
npm install @vbcdx/forgejo-plugin

npx vbcdx-forgejo --version
npx vbcdx-forgejo --help
npx vbcdx-forgejo manifest      # deterministic JSON tool manifest
npx vbcdx-forgejo mcp           # stdio MCP server (default; credential files)
npx vbcdx-forgejo serve         # network MCP server (Streamable HTTP; header credentials)
```

The default, `mcp`, is the stdio server used by DSH and standalone installs. The
`serve` command is the network/container mode — see
[Network mode](#network-mode-serve-mcp-over-streamable-http).

`npx vbcdx-forgejo` runs the package's installed binary; the same entrypoint is
on your `PATH` as `vbcdx-forgejo` after a global install. Unknown commands or
options exit `2`. Only protocol frames go to stdout in `mcp`; diagnostics go to
stderr, redacted.

## Configuration

Three environment settings, read once at startup (see `.env.example`):

| Setting | Meaning |
| --- | --- |
| `VBCDX_FORGEJO_URL` | Instance origin, optional subpath, optional trailing `/api/v1`. Required for a call. |
| `VBCDX_FORGEJO_WRITES` | `off` (default) / `write` / `full`. Destructive tools require `full`. |
| `VBCDX_FORGEJO_TIMEOUT_MS` | Total per-call deadline (default 30000, range 1000–120000). |

Tools are always discoverable. A call made without valid configuration or
credentials returns an actionable, redacted error rather than failing to list.

## Credentials

Every tool takes an absolute `credential_file` path — credentials are never CLI
arguments and are never cached between calls. The file is a literal
configuration file (no shell sourcing) with `VBCDX_AGENTS_ROLE`,
`VBCDX_AGENTS_USER` and at least one of `VBCDX_AGENTS_TOKEN` /
`VBCDX_AGENTS_PASSWORD`. It must be a regular, non-symlink file you own, mode
`0600`, inside a private `0700` directory. See `examples/credential-file.env`.

Authentication uses the token first; a Basic USER/PASSWORD retry happens only
once, and only after an explicit `401` on the token request — never on `403`.

## Deployment shapes

The same 33-tool catalogue runs three ways. Pick the one that fits; nothing about
the tools, the write gate, or the result envelope changes between them.

1. **DSH** — registered as a plugin and invoked through the DSH harness (stdio).
2. **Standalone** — installed with `npm install` / `npx` on any box and run as the
   `vbcdx-forgejo` binary (stdio; see above).
3. **Container / network** — run `vbcdx-forgejo serve` (or the Docker image) to
   expose MCP over the network, with credentials supplied per request by header.

Shapes 1 and 2 use **stdio + credential files** (the default, unchanged). Shape 3
uses the **network transport** described next.

## Network mode (`serve`): MCP over Streamable HTTP

`vbcdx-forgejo serve` starts an MCP server over the **Streamable HTTP** transport
(the current MCP network transport; responses are streamed over Server-Sent
Events). It exposes the **same finite 33-tool catalogue** — it is **not** a
generic Forgejo API proxy.

```sh
VBCDX_FORGEJO_URL=https://git.example.com \
VBCDX_FORGEJO_WRITES=off \
npx vbcdx-forgejo serve
# → MCP endpoint:  POST http://0.0.0.0:8080/mcp
# → liveness:      GET  http://0.0.0.0:8080/healthz
```

### Credentials per request, by header

There is **no credential file and no `credential_file` argument** in this mode —
credentials arrive per request in the `Authorization` header, are used for that
one request, and are never cached:

| Header | Meaning |
| --- | --- |
| `Authorization: Bearer <PAT>` | Personal access token. Forwarded upstream as Forgejo's `token` scheme. |
| `Authorization: token <PAT>` | Same as Bearer; accepted for Forgejo/Gitea familiarity. |
| `Authorization: Basic <base64(user:password)>` | Username/password. Forwarded verbatim. |

Tool discovery (`tools/list`) works **without** any credential. A tool *call*
without a credential returns an actionable, redacted error — never a crash.

A single header carries one scheme, so header mode presents exactly one
credential. The token→Basic-after-`401` retry is a **credential-file** feature (a
file can hold both a token and a password) and does not apply here.

### Configuration

`serve` reads the three settings above (`VBCDX_FORGEJO_URL`,
`VBCDX_FORGEJO_WRITES`, `VBCDX_FORGEJO_TIMEOUT_MS`) plus:

| Setting | Meaning |
| --- | --- |
| `VBCDX_FORGEJO_HTTP_PORT` | Listen port (default `8080`). |
| `VBCDX_FORGEJO_HTTP_HOST` | Bind address (default `0.0.0.0`). |
| `VBCDX_FORGEJO_TLS_CERT` | PEM certificate path; serve HTTPS directly when set with the key. |
| `VBCDX_FORGEJO_TLS_KEY` | PEM private-key path. Set **both** cert and key, or neither. |

**Credentials are never read from the environment** — only per request, by header.
The write gate (`off` / `write` / `full`) applies identically to stdio: a
destructive tool does not become reachable because the transport changed.

### TLS

- Set `VBCDX_FORGEJO_TLS_CERT` and `VBCDX_FORGEJO_TLS_KEY` to serve **HTTPS
  directly**.
- Otherwise it serves plain **HTTP**, intended to run **behind a TLS-terminating
  reverse proxy** (for example Caddy or your platform's ingress) or on a trusted
  local network only — it logs that posture at startup.
- The **outbound** connection to Forgejo always verifies TLS; verification is
  never disabled.

### Docker

The image runs `serve` as a non-root user; the base image is pinned by version
and digest and ships a `HEALTHCHECK`. No credentials are baked into the image.

```sh
docker build -t vbcdx-forgejo .

docker run --rm -p 8080:8080 \
  -e VBCDX_FORGEJO_URL=https://git.example.com \
  -e VBCDX_FORGEJO_WRITES=off \
  vbcdx-forgejo
```

Then drive it with any MCP Streamable HTTP client against `http://localhost:8080/mcp`,
sending the `Authorization` header per request. To serve HTTPS directly, mount a
cert and key and point the two TLS variables at them:

```sh
docker run --rm -p 8443:8443 \
  -e VBCDX_FORGEJO_URL=https://git.example.com \
  -e VBCDX_FORGEJO_HTTP_PORT=8443 \
  -e VBCDX_FORGEJO_TLS_CERT=/tls/cert.pem \
  -e VBCDX_FORGEJO_TLS_KEY=/tls/key.pem \
  -v /path/to/tls:/tls:ro \
  vbcdx-forgejo
```

## Registration

See `examples/registration.md` and `examples/opencode.json` for Claude Code,
Codex, OpenCode and DSH. Registration is not proof of discovery — verify with a
real `tools/list` and a `whoami` call.

## Result semantics

Every call returns one human-readable text plus a JSON envelope in
`structuredContent` with `outcome`, `effect`, `request` and `verification`.
Outcomes distinguish verified success (`ok`/`accepted`) from `refused`,
`failed`, `unverified` and `indeterminate` — a timed-out or ambiguous write is
never reported as "nothing changed".

## Forgejo MCP options

There is **no official Forgejo MCP server.** The candidate repositories
`codeberg.org/forgejo/forgejo-mcp` and `forgejo-contrib/forgejo-mcp` both return
404, and the Forgejo project publishes no MCP server of its own (checked
2026-09-15).

Gitea — which Forgejo was forked from — does ship an official server,
[`gitea/gitea-mcp`](https://gitea.com/gitea/gitea-mcp) (MIT, v1.7.0, 2026-08-27).
It is written in Go and distributed as a prebuilt binary, a Docker image, or via
`go run gitea.com/gitea/gitea-mcp@latest` — there is no npm/npx path, and its
documentation does not claim Forgejo compatibility.

Third-party Forgejo MCP servers exist on npm, none published by the Forgejo
project:

| Package | Latest | License | `npx`-runnable |
| --- | --- | --- | --- |
| [`@rubicontv/forgejo-mcp`](https://www.npmjs.com/package/@rubicontv/forgejo-mcp) | 0.17.0 (2026-09-03) | Apache-2.0 | yes (has `bin`) |
| [`@ric_/forgejo-mcp`](https://www.npmjs.com/package/@ric_/forgejo-mcp) | 0.1.7 (2026-06-18) | MIT | yes (has `bin`) |
| [`forgejo-mcp`](https://www.npmjs.com/package/forgejo-mcp) (unscoped) | 1.2.0 (2025-04-09) | GPL-3.0-or-later | no (`bin`-less) |

Those aim for broad coverage of the Forgejo API. This package takes the opposite
approach: a finite, audited catalogue of 33 tools with explicit write and
destructive controls (`VBCDX_FORGEJO_WRITES`) and a verified result envelope,
rather than a generic API surface. Choose whichever fits your needs; this
package claims no official endorsement.

## What it deliberately is not

No generic API proxy, shell/curl wrapper, env reader, local workspace
management, Git credential helper, browser-cookie login, runner or webhook
administration, repository deletion, or a CI re-run route (this Forgejo exposes
none).

## Running from a checkout

For contributors and for anyone running the code before it is published, invoke
the entrypoint directly from a working copy. This is a development convenience,
**not** the consumer install path above:

```sh
node bin/vbcdx-forgejo.js --version
node bin/vbcdx-forgejo.js --help
node bin/vbcdx-forgejo.js manifest      # deterministic JSON tool manifest
node bin/vbcdx-forgejo.js mcp           # stdio MCP server
```

## Tests

```sh
npm ci
npm test
```
