/** Coral MCP Server - stdio transport for Codex CLI integration. */

declare const __VERSION__: string;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { killAllChildren } from './codex-executor.js';
import { SessionManager } from './session-manager.js';
import { writeSessionError } from './progress.js';
import { tools, handleToolCall, activeJobs, tryClaimTerminalWrite, shutdownSignal } from './server-handlers.js';

const server = new Server(
  {
    name: 'coral',
    version: typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0',
  },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const rawArgs = args ?? {};

  const progressToken = extra._meta?.progressToken;
  const notify = progressToken == null ? undefined : extra.sendNotification?.bind(extra);

  return handleToolCall(name, rawArgs, sessionManager, progressToken, notify);
});

function shutdown() {
  process.stderr.write('Coral MCP Server shutting down...\n');

  // 1. Signal all wait handlers to exit their poll loops immediately
  shutdownSignal.abort();

  // 2. Claim terminal write for all active jobs and mark as error
  for (const [jobId, entry] of activeJobs) {
    if (tryClaimTerminalWrite(jobId, 'error')) {
      writeSessionError(entry.sessionDir, 'Server shutting down');
      entry.terminalState = 'error';
    }
    entry.controller.abort();
  }
  activeJobs.clear();

  // 3. Kill all OS-level child processes
  killAllChildren();

  server.close().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const sessionManager = new SessionManager(process.cwd());

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  process.stderr.write('Coral MCP Server running on stdio\n');
}).catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
