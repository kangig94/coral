import { z } from 'zod';
import type { NotifyFn } from '../providers/types.js';
import { handleWait } from '../runner/job-manager.js';
import type { SessionManager } from '../runner/session-manager.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { proxyToolCall } from './backend-client.js';
export { getTools } from './tools.js';

const waitToolSchema = z.object({
  sessions: z.array(z.string().uuid()).min(1, 'At least one session required'),
  timeout_seconds: z.number().min(1).max(1200).optional(),
  poll_ms: z.number().int().min(50).max(5000).optional(),
});

async function handleWaitTool(rawArgs: Record<string, unknown>, notify?: NotifyFn, progressToken?: string | number): Promise<McpResult> {
  const parsed = waitToolSchema.safeParse(rawArgs);
  if (!parsed.success) throw parsed.error;
  return handleWait(parsed.data, notify, progressToken);
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
  _mgr: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
): Promise<McpResult> {
  try {
    if (name === 'wait') return await handleWaitTool(rawArgs, notify, progressToken);
    return await proxyToolCall(name, rawArgs, process.cwd());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
