// The `serve` command: a network-served MCP server (issue #8).
//
// Transport is MCP **Streamable HTTP** (the current transport, superseding the
// old HTTP+SSE pair), with responses streamed over Server-Sent Events — one
// shape that satisfies both "sse" and "https". It runs in **stateless** mode: a
// fresh MCP server and transport are built per request, so there is no
// process-wide session or credential state between requests.
//
// Credentials arrive per request in the `Authorization` header (Bearer/token or
// Basic), are resolved fresh for that one request via credential-header.js, and
// are never cached. Tool discovery works with no credentials; an uncredentialed
// call returns a redacted, actionable error. The write gate, the finite 33-tool
// catalogue, redaction and the outbound TLS posture are all identical to stdio —
// only the transport and the credential source change.
//
// Lightweight: the listener is built on Node's built-in node:http / node:https;
// the only dependency is the already-pinned @modelcontextprotocol/sdk (its HTTP
// glue is a transitive dependency of that same SDK). No header value, request
// body or credential is ever logged.

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { TOOLS, getTool, annotationsFor, httpInputSchema } from './registry.js';
import { executeTool } from './dispatch.js';
import { authFromHeader } from './credential-header.js';
import { SERVER_NAME } from './constants.js';

export const DEFAULT_HTTP_PORT = 8080;
const MCP_PATH = '/mcp';
const HEALTH_PATH = '/healthz';

function version() {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  return pkg.version;
}

function stderrLog(msg) {
  process.stderr.write(`[forgejo-mcp] ${msg}\n`);
}

/**
 * Read network-mode options from the environment. Credentials are deliberately
 * absent — they arrive per request by header, never from the environment.
 */
export function loadHttpOptions(env = process.env) {
  const rawPort = env.VBCDX_FORGEJO_HTTP_PORT;
  let port = DEFAULT_HTTP_PORT;
  let portError = null;
  if (rawPort !== undefined && String(rawPort).trim() !== '') {
    const v = String(rawPort).trim();
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
      portError = 'VBCDX_FORGEJO_HTTP_PORT must be an integer between 1 and 65535.';
    } else {
      port = Number(v);
    }
  }
  const host = env.VBCDX_FORGEJO_HTTP_HOST && String(env.VBCDX_FORGEJO_HTTP_HOST).trim() !== ''
    ? String(env.VBCDX_FORGEJO_HTTP_HOST).trim()
    : '0.0.0.0';
  const certPath = env.VBCDX_FORGEJO_TLS_CERT && String(env.VBCDX_FORGEJO_TLS_CERT).trim() !== ''
    ? String(env.VBCDX_FORGEJO_TLS_CERT).trim()
    : null;
  const keyPath = env.VBCDX_FORGEJO_TLS_KEY && String(env.VBCDX_FORGEJO_TLS_KEY).trim() !== ''
    ? String(env.VBCDX_FORGEJO_TLS_KEY).trim()
    : null;
  return { port, host, certPath, keyPath, portError };
}

/**
 * Probe the local /healthz endpoint. Used by the container HEALTHCHECK and the
 * `healthcheck` command. Resolves true only on a 200.
 *
 * When TLS is configured the probe is over https to 127.0.0.1 and tolerates a
 * self-signed certificate — this is a loopback self-check, NOT the outbound
 * Forgejo connection, whose TLS verification is never relaxed.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<boolean>}
 */
export function httpHealthcheck({ env = process.env } = {}) {
  const { port } = loadHttpOptions(env);
  const tls = !!(env.VBCDX_FORGEJO_TLS_CERT && env.VBCDX_FORGEJO_TLS_KEY);
  const lib = tls ? https : http;
  const options = { host: '127.0.0.1', port, path: HEALTH_PATH, method: 'GET', timeout: 3000 };
  if (tls) options.rejectUnauthorized = false; // loopback self-check only
  return new Promise((resolve) => {
    const req = lib.request(options, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Build the per-request MCP server. Its ListTools is the same finite catalogue
// as stdio but advertises the credential_file-free input schema; its CallTool
// resolves the credential from this one request's Authorization header.
function buildServer({ config, authHeader, shutdownSignal, log }) {
  const server = new Server({ name: SERVER_NAME, version: version() }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: httpInputSchema(t.name),
      outputSchema: t.output,
      annotations: { title: t.name, ...annotationsFor(t.effect) },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = getTool(name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${String(name)}`);
    }
    const signal = extra?.signal
      ? AbortSignal.any([extra.signal, shutdownSignal])
      : shutdownSignal;
    return executeTool(tool, args, {
      config,
      signal,
      log,
      resolveAuth: () => authFromHeader(authHeader),
      inputSchema: httpInputSchema(name),
    });
  });

  return server;
}

// Dispatch one Node HTTP request. Stateless: build a fresh server + transport,
// serve, and tear both down when the response closes.
async function handle(req, res, { config, shutdownController, log }) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === HEALTH_PATH) {
    return sendJson(res, 200, { status: 'ok', service: SERVER_NAME, tools: TOOLS.length });
  }

  if (path !== MCP_PATH) {
    return sendJson(res, 404, { error: 'not_found', message: `No route for ${req.method} ${path}. Use POST ${MCP_PATH} or GET ${HEALTH_PATH}.` });
  }

  // Stateless Streamable HTTP: only POST carries a request. GET/DELETE would
  // manage a server-initiated stream or a session, neither of which exists here.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJsonRpcError(res, 405, -32000, `Method not allowed. Use POST ${MCP_PATH}.`);
  }

  const server = buildServer({
    config,
    authHeader: req.headers.authorization,
    shutdownSignal: shutdownController.signal,
    log,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  // The transport reads and parses the request body itself; we never touch it,
  // so no credential or body content is available to log.
  await transport.handleRequest(req, res);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sendJsonRpcError(res, status, code, message) {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/**
 * Start the network-served MCP server.
 *
 * @param {object} [opts]
 * @param {object} [opts.config] loaded service config (loadConfig by default)
 * @param {object} [opts.http]   network options (loadHttpOptions by default)
 * @param {(msg:string)=>void} [opts.log]
 * @param {boolean} [opts.installSignals] wire SIGTERM/SIGINT (default true)
 * @returns {Promise<{server:import('node:http').Server, port:number, close:()=>Promise<void>}>}
 */
export async function runHttpServer({ config = loadConfig(), http: httpOpts = loadHttpOptions(), log = stderrLog, installSignals = true } = {}) {
  if (httpOpts.portError) throw new Error(httpOpts.portError);
  if ((httpOpts.certPath && !httpOpts.keyPath) || (!httpOpts.certPath && httpOpts.keyPath)) {
    throw new Error('TLS requires both VBCDX_FORGEJO_TLS_CERT and VBCDX_FORGEJO_TLS_KEY, or neither.');
  }

  const shutdownController = new AbortController();

  let listener;
  let tls = false;
  if (httpOpts.certPath && httpOpts.keyPath) {
    let cert;
    let key;
    try {
      cert = readFileSync(httpOpts.certPath);
      key = readFileSync(httpOpts.keyPath);
    } catch {
      // Never echo the paths' contents; name only which setting failed.
      throw new Error('TLS certificate or key could not be read from the configured paths.');
    }
    listener = https.createServer({ cert, key }, wrap({ config, shutdownController, log }));
    tls = true;
  } else {
    listener = http.createServer(wrap({ config, shutdownController, log }));
  }

  if (config.insecure) {
    log('VBCDX_FORGEJO_URL is http (unencrypted); use it only on a trusted local network.');
  }

  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(httpOpts.port, httpOpts.host, () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });

  // The OS may assign the port (host config passes 0 in tests); read it back.
  const boundPort = listener.address().port;
  const scheme = tls ? 'https' : 'http';
  log(`ready: MCP over Streamable HTTP at ${scheme}://${httpOpts.host}:${boundPort}${MCP_PATH} — ${TOOLS.length} tools, writes=${config.writes}.`);
  if (!tls) {
    log('serving plain HTTP; put a TLS-terminating proxy in front or run only on a trusted network.');
  }

  const close = async () => {
    shutdownController.abort();
    await new Promise((resolve) => listener.close(() => resolve()));
  };

  if (installSignals) {
    const shutdown = async () => {
      try {
        await close();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  return { server: listener, port: boundPort, close };
}

// Wrap the async handler so any thrown error becomes a redacted 500 rather than
// an unhandled rejection that could crash the process or leak a stack.
function wrap(ctx) {
  return (req, res) => {
    handle(req, res, ctx).catch((e) => {
      if (ctx.log) ctx.log(`request handling error: ${redact(e)}`);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal server error.');
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
  };
}

function redact(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  return msg.slice(0, 200);
}
