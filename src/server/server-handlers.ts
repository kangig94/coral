import { z } from 'zod';
import { handleCoralDispatch } from '../coral/dispatch.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { getAllTools, getProvider, getProviderNames } from '../providers/registry.js';
import type { NotifyFn } from '../providers/types.js';
import { handleWait } from '../runner/job-manager.js';
import { SessionManager } from '../runner/session-manager.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { handleWorkflow } from '../workflow/handler.js';

const CORAL_OP_PREFIX = 'coral:';

const waitToolSchema = z.object({
  sessions: z.array(z.string().uuid()).min(1, 'At least one session required'),
  timeout_seconds: z.number().min(1).max(1200).optional(),
});

const waitTool = {
  name: 'wait',
  description: 'Wait for session completion. Monitors one or more sessions (from any provider) and returns when the first completes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessions: { type: 'array', items: { type: 'string' }, description: 'Session UUIDs to monitor (from exec/fork response)' },
      timeout_seconds: { type: 'number', description: 'Max wait time in seconds (1-1200, default 600)' },
    },
    required: ['sessions'],
  },
};

const workflowProviderSchema = (): Record<string, unknown> => {
  const providers = getProviderNames();
  if (providers.length === 0) {
    return { type: 'string', description: 'Default provider for atoms without @ override' };
  }
  return {
    type: 'string',
    enum: providers,
    description: 'Default provider for atoms without @ override',
  };
};

function workflowTool() {
  return {
    name: 'workflow',
    description: 'Execute a deterministic multi-agent pipeline. DSL: "(architect, critic) -> resolver". Use @provider for per-atom provider override.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string', description: 'Pipeline expression: "(a, b) -> c" or "a -> b -> c"' },
        prompt: { type: 'string', description: 'Initial prompt for the first pipeline step' },
        provider: workflowProviderSchema(),
        args: { type: 'object', description: 'Per-atom args map: { atomName: { model?, working_directory?, files?, flags?, ...context } }' },
        stale_timeout_seconds: { type: 'number', description: 'Seconds of inactivity before stale atom recovery triggers (0 disables, default: 900)' },
      },
      required: ['expression', 'prompt'],
    },
  };
}

export function getTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  registerBuiltInProviders();
  return [...getAllTools(), waitTool, workflowTool()];
}

export const tools = getTools();

async function handleWaitTool(rawArgs: Record<string, unknown>, notify?: NotifyFn, progressToken?: string | number): Promise<McpResult> {
  const parsed = waitToolSchema.safeParse(rawArgs);
  if (!parsed.success) throw parsed.error;
  return handleWait(parsed.data, notify, progressToken);
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
  mgr: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
): Promise<McpResult> {
  try {
    registerBuiltInProviders();
    const provider = getProvider(name);
    if (provider) {
      const rawOp = (rawArgs as { op?: unknown }).op;
      if (typeof rawOp === 'string' && rawOp.startsWith(CORAL_OP_PREFIX)) {
        return await handleCoralDispatch(name, rawArgs, mgr, progressToken, notify);
      }
      return await provider.handleOp(rawArgs, mgr, progressToken, notify);
    }
    if (name === 'wait') return await handleWaitTool(rawArgs, notify, progressToken);
    if (name === 'workflow') return handleWorkflow(rawArgs, handleToolCall, mgr, progressToken, notify);
    return textResult(`Unknown tool: ${name}`, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
