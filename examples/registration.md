# Registering the forgejo MCP server

Use the server name `forgejo`. The examples run the `vbcdx-forgejo` binary
through `npx -y --package=@vbcdx/forgejo-plugin`; pin a
version (`--package=@vbcdx/forgejo-plugin@<version>`) in production, or install it globally
(`npm install -g @vbcdx/forgejo-plugin`) and register `vbcdx-forgejo mcp`. Credentials are
never passed here: each tool call carries an absolute `credential_file`.

## Claude Code (user scope)

```sh
claude mcp add forgejo --scope user \
  -e VBCDX_FORGEJO_URL=https://git.example.com \
  -e VBCDX_FORGEJO_WRITES=off \
  -- npx -y --package=@vbcdx/forgejo-plugin vbcdx-forgejo mcp
```

## Codex (user registration)

```sh
codex mcp add forgejo \
  --env VBCDX_FORGEJO_URL=https://git.example.com \
  --env VBCDX_FORGEJO_WRITES=off \
  -- npx -y --package=@vbcdx/forgejo-plugin vbcdx-forgejo mcp
```

## OpenCode

See `opencode.json` — merge the `mcp.forgejo` entry into the chosen user config
or the project's `opencode.json`.

## Verify

Registration is not proof of discovery. Confirm the server actually works:

```sh
npx -y --package=@vbcdx/forgejo-plugin vbcdx-forgejo --version
npx -y --package=@vbcdx/forgejo-plugin vbcdx-forgejo manifest | head
```

Then, from the harness, list tools and call `whoami` with a real
`credential_file`.
