/** Coral Discuss MCP Server - stdio transport for discussion session management. */

declare const __VERSION__: string;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SessionStore } from './session-store.js';
import { tools, handleToolCall } from './server-handlers.js';

const server = new Server(
  { name: 'coral-discuss', version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.1.0' },
  { capabilities: { tools: {} } },
);

const store = new SessionStore(process.cwd());

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args ?? {}, store);
});

function shutdown() {
  process.stderr.write('Coral Discuss MCP Server shutting down...\n');
  server.close().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  process.stderr.write('Coral Discuss MCP Server running on stdio\n');
}).catch((error: unknown) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
