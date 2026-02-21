/** Coral MCP Server - stdio transport for Codex CLI integration. */

declare const __VERSION__: string;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { killAllChildren } from './codex-executor.js';
import { SessionManager } from './session-manager.js';
import { appendFinalResult } from './progress.js';
import { tools, handleToolCall, activeBackgroundFiles } from './server-handlers.js';

const server = new Server(
  { name: 'coral', version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const rawArgs = args ?? {};

  const progressToken = extra._meta?.progressToken;
  const notify = (progressToken != null && extra.sendNotification)
    ? extra.sendNotification.bind(extra)
    : undefined;

  return handleToolCall(name, rawArgs, sessionManager, progressToken, notify);
});

function shutdown() {
  process.stderr.write('Coral MCP Server shutting down...\n');
  for (const pFile of activeBackgroundFiles) {
    appendFinalResult(pFile, 'error', { error: 'Server shutting down' });
  }
  activeBackgroundFiles.clear();
  killAllChildren();
  server.close().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let sessionManager: SessionManager;

async function main() {
  sessionManager = new SessionManager(process.cwd());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Coral MCP Server running on stdio\n');
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
