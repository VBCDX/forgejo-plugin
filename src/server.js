// The `mcp` command: a stdio MCP server (spec §2, §3).
//
// Only protocol frames go to stdout (the SDK's stdio transport owns it);
// every diagnostic goes to stderr, redacted. Tools stay discoverable even with
// missing or invalid service configuration — a configuration problem only
// surfaces when a call actually needs the network. EOF on stdin, SIGTERM and
// SIGINT all shut the server down and clean up.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { TOOLS, getTool, annotationsFor } from './registry.js';
import { executeTool } from './dispatch.js';
import { SERVER_NAME } from './constants.js';

function version() {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  return pkg.version;
}

function diag(msg) {
  process.stderr.write(`[forgejo-mcp] ${msg}\n`);
}

export async function runMcpServer({ config = loadConfig(), connect = true } = {}) {
  if (config.insecure) {
    diag('VBCDX_FORGEJO_URL is http (unencrypted); use it only on a trusted local network.');
  }

  const server = new Server({ name: SERVER_NAME, version: version() }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input,
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
    return executeTool(tool, args, { config, signal: extra?.signal, log: diag });
  });

  server.onclose = () => {
    process.exit(0);
  };

  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  if (connect) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    diag(`ready: ${TOOLS.length} tools available (writes=${config.writes}).`);
  }
  return server;
}
