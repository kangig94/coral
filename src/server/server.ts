/** Coral AX MCP Server - unified stdio transport for Codex and Claude CLI integration. */

declare const __VERSION__: string;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { killAllChildren } from '../runner/engine.js';
import { SessionManager } from '../runner/session-manager.js';
import { writeSessionError } from '../runner/progress.js';
import { activeSessions, tryClaimTerminalWrite, shutdownSignal } from '../runner/job-manager.js';
import { getTools, handleToolCall } from './server-handlers.js';

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

  // 1. Signal all wait handlers to exit their poll loops immediately
  shutdownSignal.abort();

  // 2. Claim terminal write for all active sessions and mark as error
  for (const [sessionId, entry] of activeSessions) {
    if (tryClaimTerminalWrite(sessionId)) {
      writeSessionError(entry.sessionDir, 'Server shutting down');
      entry.terminalState = 'error';
    }
    entry.controller.abort();
  }
  activeSessions.clear();

  // 3. Kill all OS-level child processes
  killAllChildren();

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
