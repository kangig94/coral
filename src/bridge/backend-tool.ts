import { z } from 'zod';
import { getBackendStatus, shutdownBackend } from './backend-client.js';
import type { ToolDescriptor } from './bridge-types.js';
import { textResult, type McpResult } from '../shared/mcp-utils.js';

export const waitToolDescriptor: ToolDescriptor = {
  name: 'wait',
  description: 'Wait for launched jobs and stream progress until completion or timeout.',
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

export const backendInputSchema = z.object({
  op: z.enum(['status', 'shutdown']),
});

export const backendToolDescriptor: ToolDescriptor = {
  name: 'backend',
  description: 'Inspect or gracefully shut down the Coral backend daemon.',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['status', 'shutdown'],
        description: 'Backend operation to run.',
      },
    },
    required: ['op'],
  },
};

export async function handleBackendToolCall(
  args: Record<string, unknown>,
  pluginRoot: string,
): Promise<McpResult> {
  const parsed = backendInputSchema.safeParse(args);
  if (!parsed.success) {
    return textResult(parsed.error.message, true);
  }

  if (parsed.data.op === 'status') {
    const status = await getBackendStatus(pluginRoot);
    if (!status) {
      return textResult('Backend is not running', true);
    }
    return textResult(JSON.stringify(status));
  }

  const shutdown = await shutdownBackend(pluginRoot);
  if (!shutdown.ok) {
    return textResult(shutdown.reason, true);
  }

  return textResult(JSON.stringify({ status: 'shutting_down' }));
}

export function buildToolList(remoteTools: ToolDescriptor[] | null): ToolDescriptor[] {
  const filteredRemoteTools = (remoteTools ?? []).filter((tool) => tool.name !== waitToolDescriptor.name && tool.name !== backendToolDescriptor.name);
  return [...filteredRemoteTools, waitToolDescriptor, backendToolDescriptor];
}
