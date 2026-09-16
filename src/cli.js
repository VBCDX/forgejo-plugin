// CLI dispatch (spec §1). Commands: mcp, manifest, --help, --version.
// Any unknown command or option exits 2.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializeManifest } from './manifest.js';
import { runMcpServer } from './server.js';
import { runHttpServer, httpHealthcheck } from './httpserver.js';

function version() {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  return pkg.version;
}

const HELP = `vbcdx-forgejo — MCP server for a finite, verified Forgejo tool catalog (contract vbcdx.forgejo/1).

Usage:
  vbcdx-forgejo mcp         Start the stdio MCP server (default; credentials from per-call files).
  vbcdx-forgejo serve       Start the network MCP server (Streamable HTTP; credentials per request by header).
  vbcdx-forgejo healthcheck Probe a locally-running serve endpoint; exit 0 if healthy, 1 otherwise.
  vbcdx-forgejo manifest    Print the deterministic JSON tool manifest and exit.
  vbcdx-forgejo --help      Show this help and exit.
  vbcdx-forgejo --version   Print the package version and exit.

Service configuration (environment, read once at startup):
  VBCDX_FORGEJO_URL         Forgejo instance origin, optionally ending in /api/v1 (required for a call).
  VBCDX_FORGEJO_WRITES      off (default) | write | full. Destructive tools require full.
  VBCDX_FORGEJO_TIMEOUT_MS  Total per-call deadline in ms (default 30000, range 1000-120000).

Network mode (serve) additionally reads:
  VBCDX_FORGEJO_HTTP_PORT   Listen port (default 8080).
  VBCDX_FORGEJO_HTTP_HOST   Bind address (default 0.0.0.0).
  VBCDX_FORGEJO_TLS_CERT    PEM certificate path; serve HTTPS directly when set with the key.
  VBCDX_FORGEJO_TLS_KEY     PEM private-key path (both cert and key, or neither).
  Endpoints: POST /mcp (MCP), GET /healthz (liveness). Credentials arrive per request in the
  Authorization header (Bearer/token <PAT> or Basic <base64(user:password)>), never from the environment.

In stdio mode every tool takes an absolute credential_file argument; credentials are never passed on the
command line. Tools are always discoverable; a call without valid configuration or credentials returns an
actionable error.`;

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {Promise<number>} intended process exit code (mcp does not return)
 */
export async function main(argv) {
  const [command, ...rest] = argv;

  // Top-level help/version flags in the command position.
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (command === 'manifest') {
    if (rest.length > 0) {
      process.stderr.write(`vbcdx-forgejo: 'manifest' takes no arguments\n`);
      return 2;
    }
    process.stdout.write(`${serializeManifest()}\n`);
    return 0;
  }

  if (command === 'mcp') {
    if (rest.length > 0) {
      process.stderr.write(`vbcdx-forgejo: 'mcp' takes no arguments\n`);
      return 2;
    }
    await runMcpServer();
    // The server owns the process lifetime; it exits via signal/EOF handlers.
    return new Promise(() => {});
  }

  if (command === 'serve') {
    if (rest.length > 0) {
      process.stderr.write(`vbcdx-forgejo: 'serve' takes no arguments\n`);
      return 2;
    }
    try {
      await runHttpServer();
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      process.stderr.write(`vbcdx-forgejo: serve failed to start: ${msg.slice(0, 200)}\n`);
      return 1;
    }
    // The listener owns the process lifetime; it exits via signal handlers.
    return new Promise(() => {});
  }

  if (command === 'healthcheck') {
    if (rest.length > 0) {
      process.stderr.write(`vbcdx-forgejo: 'healthcheck' takes no arguments\n`);
      return 2;
    }
    const ok = await httpHealthcheck();
    return ok ? 0 : 1;
  }

  if (command === undefined) {
    process.stderr.write(`vbcdx-forgejo: no command given\n\n${HELP}\n`);
    return 2;
  }

  process.stderr.write(`vbcdx-forgejo: unknown command '${command}'\n`);
  return 2;
}
