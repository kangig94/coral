/** Coral AX MCP Server - unified stdio transport for Codex and Claude CLI integration. */

declare const __VERSION__: string;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from '../runner/session-manager.js';
import { shutdownSignal } from '../runner/job-manager.js';
import { handleToolCall } from './server-handlers.js';
import { getTools } from './tools.js';

const server = new Server(
  {
    name: 'coral',
    version: typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0',
  },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const rawArgs = args ?? {};

  const progressToken = extra._meta?.progressToken;
  const notify = progressToken == null ? undefined : extra.sendNotification?.bind(extra);

  return handleToolCall(name, rawArgs, sessionManager, progressToken, notify);
});

function shutdown() {
  process.stderr.write('Coral AX MCP Server shutting down...\n');
  shutdownSignal.abort();
  server.close().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const sessionManager = new SessionManager(process.cwd());

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  process.stderr.write('Coral AX MCP Server running on stdio\n');
}).catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
