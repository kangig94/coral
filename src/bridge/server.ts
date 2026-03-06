declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { join } from 'node:path';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureBackend, proxyToolCall, streamWait } from './backend-client.js';
import { isRecord, textResult } from '../shared/mcp-utils.js';

const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');
const version = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';

const waitInputSchema = z.object({
  jobs: z.array(z.string()).min(1, 'At least one job required'),
  timeout_seconds: z.number().min(1).max(1200).optional(),
  cursor: z.string().min(1).optional(),
});

type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ProgressNotification = {
  method: 'notifications/progress';
  params: {
    progressToken: string | number;
    progress: number;
    message: string;
  };
};

function waitToolDescriptor(tool: ToolDescriptor): ToolDescriptor {
  return {
    ...tool,
    inputSchema: {
      type: 'object',
      properties: {
        jobs: { type: 'array', items: { type: 'string' }, description: 'Job IDs to monitor (from exec/fork response)' },
        timeout_seconds: { type: 'number', description: 'Max wait time in seconds (1-1200, default 600)' },
        cursor: { type: 'string', description: 'Opaque stream cursor returned by the previous wait call' },
      },
      required: ['jobs'],
    },
  };
}

async function fetchTools(): Promise<ToolDescriptor[]> {
  const { port, token } = await ensureBackend();
  const response = await fetch(`http://127.0.0.1:${port}/tools`, {
    headers: { 'X-Coral-Backend-Token': token },
  });
  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) return [];

  return body
    .filter((tool): tool is ToolDescriptor => (
      isRecord(tool)
      && typeof tool.name === 'string'
      && typeof tool.description === 'string'
      && isRecord(tool.inputSchema)
    ))
    .map((tool) => (tool.name === 'wait' ? waitToolDescriptor(tool) : tool));
}

function sendProgress(
  notify: ((notification: ProgressNotification) => Promise<void>) | undefined,
  progressToken: string | number | undefined,
  progress: number,
  message: string,
): void {
  if (!notify || progressToken == null) return;
  void notify({
    method: 'notifications/progress',
    params: { progressToken, progress, message },
  }).catch(() => {});
}

const server = new Server(
  { name: 'coral', version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return { tools: await fetchTools() };
  } catch {
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name } = request.params;
  const rawArgs = isRecord(request.params.arguments) ? request.params.arguments : {};
  const progressToken = extra._meta?.progressToken;
  const notify = progressToken == null ? undefined : extra.sendNotification?.bind(extra);

  try {
    if (name === 'wait') {
      const parsed = waitInputSchema.parse(rawArgs);
      const backendInfo = await ensureBackend();

      let progressCount = 0;
      for await (const event of streamWait(
        parsed.jobs,
        parsed.timeout_seconds,
        backendInfo,
        parsed.cursor,
      )) {
        if (event.type === 'progress') {
          sendProgress(notify, progressToken, ++progressCount, event.message);
          continue;
        }

        if (event.type === 'terminal') {
          return textResult(JSON.stringify({
            completedJobId: event.completedJobId,
            sessionId: event.sessionId,
            remainingJobIds: event.remainingJobIds,
            result: event.result,
          }));
        }

        return textResult(JSON.stringify({
          timeout: true,
          runningJobIds: event.runningJobIds,
        }), true);
      }

      return textResult('wait stream ended without a terminal event', true);
    }

    const response = await proxyToolCall(name, rawArgs, {
      projectRoot: process.cwd(),
      pluginRoot,
    });

    if (isRecord(response) && response.status === 'rejected') {
      return textResult(
        typeof response.message === 'string' ? response.message : JSON.stringify(response),
        true,
      );
    }

    return textResult(JSON.stringify(response));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(message, true);
  }
});

function shutdown(): void {
  void server.close().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
