// Programmatic entry point. The executable is bin/vbcdx-forgejo.js; this module
// exposes the pieces tests and embedders need.

export { TOOLS, getTool, toolNames, annotationsFor } from './registry.js';
export { executeTool } from './dispatch.js';
export { loadConfig, normalizeUrl } from './config.js';
export { buildManifest, serializeManifest } from './manifest.js';
export { runMcpServer } from './server.js';
export { runHttpServer, httpHealthcheck, loadHttpOptions, DEFAULT_HTTP_PORT } from './httpserver.js';
export { authFromHeader } from './credential-header.js';
export { SERVICE, CONTRACT, SERVER_NAME } from './constants.js';
