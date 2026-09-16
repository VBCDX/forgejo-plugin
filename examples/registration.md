# Registering the forgejo MCP server

Use the distinct server identity `forgejo`. Register against the installed
`vbcdx-forgejo` binary (`npm install @vbcdx/forgejo-plugin`, then invoke it with
`npx vbcdx-forgejo`). Credentials are never passed here — each tool call carries
an absolute `credential_file`.

## Claude Code (user scope)

```sh
claude mcp add forgejo --scope user \
  -e VBCDX_FORGEJO_URL=https://git.example.com \
  -e VBCDX_FORGEJO_WRITES=off \
  -- npx vbcdx-forgejo mcp
```

## Codex (user registration)

```sh
codex mcp add forgejo \
  --env VBCDX_FORGEJO_URL=https://git.example.com \
  --env VBCDX_FORGEJO_WRITES=off \
  -- npx vbcdx-forgejo mcp
```

## OpenCode

See `opencode.json` — merge the `mcp.forgejo` entry into the chosen user config
or the project's `opencode.json`.

## DSH

```sh
dsh plugin --profile web add /absolute/path/to/node_modules/@vbcdx/forgejo-plugin
```

The shipped `cordis.patch.yml` inserts the `mcp-forgejo` row. Before booting the
selected profile, set `VBCDX_FORGEJO_ENTRYPOINT` to the absolute installed
`node_modules/@vbcdx/forgejo-plugin/bin/vbcdx-forgejo.js` and run
`node <entrypoint> --version` to confirm it resolves; an empty or missing path
is a failed registration.

## Verify

Registration is not proof of discovery. Confirm the server actually works:

```sh
npx vbcdx-forgejo --version
npx vbcdx-forgejo manifest | head
```

Then, from the harness, list tools and call `whoami` with a real
`credential_file`.
