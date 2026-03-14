declare const __PLUGIN_ROOT__: string;
declare const __VERSION__: string;

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureBackend, proxyToolCall, streamWait, type WaitCursorRef } from './backend-client.js';
import { buildToolList, handleBackendToolCall } from './backend-tool.js';
import { isRecord, jsonResult, mcpError, textResult, type McpResult } from '../shared/mcp-utils.js';
import { waitInputSchema, MAX_INLINE } from '../shared/schemas.js';

const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..', '..');
const version = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';

export type ToolDescriptor = {
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

function fitsInlineWaitPayload(payload: Record<string, unknown>): boolean {
  return JSON.stringify(jsonResult(payload)).length <= MAX_INLINE;
}

async function fetchTools(): Promise<ToolDescriptor[]> {
  const { port, host, token } = await ensureBackend(pluginRoot);
  const response = await fetch(`http://${host}:${port}/tools`, {
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

function parseBackendWaitStatus(error: Error): number | null {
  const match = error.message.match(/^Backend request failed: (\d{3})(?:\b| )/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function waitFailureResult(error: unknown): ReturnType<typeof mcpError> {
  if (error instanceof Error) {
    const status = parseBackendWaitStatus(error);
    if (status === 403) {
      return mcpError({
        error: 'scope_mismatch',
        message: 'Requested jobs are outside the current project scope',
      });
    }
    if (status === 404) {
      return mcpError({
        error: 'jobs_not_found',
        message: 'Requested jobs were not found',
      });
    }
    if (status === 400) {
      return mcpError({
        error: 'invalid_request',
        message: error.message,
      });
    }
    return mcpError({
      error: 'wait_transport_failure',
      message: error.message,
    });
  }

  return mcpError({
    error: 'wait_transport_failure',
    message: String(error),
  });
}

function isTransientStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // undici throws TypeError("terminated") when SSE connection is killed mid-stream
  if (error.message === 'terminated') return true;
  // Node.js connection-level errors
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ECONNABORTED';
}

function isMcpTextResult(value: unknown): value is McpResult {
  return isRecord(value)
    && typeof value.isError === 'boolean'
    && Array.isArray(value.content)
    && value.content.every((entry) =>
      isRecord(entry)
      && entry.type === 'text'
      && typeof entry.text === 'string');
}

const server = new Server(
  { name: 'coral', version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return { tools: buildToolList(await fetchTools()) };
  } catch {
    return { tools: buildToolList(null) };
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
      const cursorRef: WaitCursorRef = { lastEventId: parsed.cursor };
      let progressCount = 0;
      let retriesLeft = 2;

      while (true) {
        const backendInfo = await ensureBackend(pluginRoot);

        try {
          for await (const event of streamWait(
            parsed.jobs,
            parsed.timeout_seconds,
            backendInfo,
            cursorRef.lastEventId,
            extra.signal,
            process.cwd(),
            cursorRef,
          )) {
            switch (event.type) {
              case 'progress':
                sendProgress(notify, progressToken, ++progressCount, event.message);
                continue;
              case 'queued':
                sendProgress(notify, progressToken, ++progressCount, `queued (position ${event.queuePosition})`);
                continue;
              case 'terminal': {
                const { content: rawContent, ...resultMeta } = event.result;
                const isWorkflow = event.result.workflow !== undefined;
                let text: string | undefined;
                if (isWorkflow) {
                  try { text = readFileSync(event.resultPath, 'utf-8'); } catch { /* fall through to path-only */ }
                } else {
                  text = rawContent;
                }

                const responseBase = {
                  state: 'ended' as const,
                  completedJobId: event.completedJobId,
                  sessionId: event.sessionId,
                  remainingJobIds: event.remainingJobIds,
                };
                const pathFirstResult = { ...resultMeta, path: event.resultPath };
                const embeddedPayload = { ...responseBase, result: { ...pathFirstResult, content: text } };

                if (text !== undefined && fitsInlineWaitPayload(embeddedPayload)) {
                  return jsonResult(embeddedPayload);
                }
                return jsonResult({ ...responseBase, result: pathFirstResult });
              }
              case 'timeout':
                return jsonResult({
                  state: 'running',
                  runningJobIds: event.runningJobIds,
                });
            }
          }

          return mcpError({
            error: 'wait_transport_failure',
            message: 'wait stream ended without a terminal event',
          });
        } catch (waitError) {
          // Abort signal is authoritative — covers both AbortError and undici TypeError("terminated")
          if (extra.signal.aborted) {
            return jsonResult({
              state: 'running',
              runningJobIds: parsed.jobs,
            });
          }
          // ensureBackend failures are not transient SSE errors — surface immediately
          if (retriesLeft-- <= 0 || !isTransientStreamError(waitError)) {
            return waitFailureResult(waitError);
          }
          await delay(500);
        }
      }
    }

    if (name === 'backend') {
      return handleBackendToolCall(rawArgs, pluginRoot);
    }

    const response = await proxyToolCall(name, rawArgs, {
      projectRoot: process.cwd(),
      pluginRoot,
    });

    if (isMcpTextResult(response)) {
      return response;
    }

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
