import { z } from 'zod';
import { CORAL_OP_PREFIX, handleCoralDispatch } from '../coral/dispatch.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { getAllTools, getProvider, getProviderNames } from '../providers/registry.js';
import type { NotifyFn } from '../providers/types.js';
import { handleWait } from '../runner/job-manager.js';
import { SessionManager } from '../runner/session-manager.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { handleBatchAbort } from '../providers/session-ops.js';
import { handleWorkflow } from '../workflow/handler.js';

const waitToolSchema = z.object({
  sessions: z.array(z.string().uuid()).min(1, 'At least one session required'),
  timeout_seconds: z.number().min(1).max(1200).optional(),
  poll_ms: z.number().int().min(50).max(5000).optional(),
});

const abortToolSchema = z.object({
  sessions: z.array(z.string().uuid()).min(1, 'At least one session required'),
});

const waitTool = {
  name: 'wait',
  description: 'Wait for session completion. Monitors one or more sessions (from any provider) and returns when the first completes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessions: { type: 'array', items: { type: 'string' }, description: 'Session UUIDs to monitor (from exec/fork response)' },
      timeout_seconds: { type: 'number', description: 'Max wait time in seconds (1-1200, default 600)' },
      poll_ms: { type: 'number', description: 'Poll interval in ms (50-5000, default from CORAL_WAIT_POLL_MS or 500)' },
    },
    required: ['sessions'],
  },
};

const abortTool = {
  name: 'abort',
  description: 'Abort active sessions. Provider-agnostic — works for codex, claude, and workflow sessions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sessions: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description: 'Session UUIDs to abort',
      },
    },
    required: ['sessions'],
  },
};

const workflowProviderSchema = (): Record<string, unknown> => {
  const baseSchema = { type: 'string', description: 'Default provider for atoms without @ override' };
  const providers = getProviderNames();
  if (providers.length === 0) return baseSchema;
  return { ...baseSchema, enum: providers };
};

function workflowTool() {
  return {
    name: 'workflow',
    description: 'Execute a deterministic multi-agent pipeline. DSL: "(architect, critic) -> resolver". Use @provider for per-atom provider override and atoms for per-atom config.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string', description: 'Pipeline expression: "(a, b) -> c" or "a -> b -> c"' },
        prompt: { type: 'string', description: 'Initial prompt for the first pipeline step' },
        provider: workflowProviderSchema(),
        atoms: { type: 'object', description: 'Per-atom config: { atomName: { effort?, instruction? } }' },
        stale_timeout_seconds: { type: 'number', description: 'Seconds of inactivity before stale atom recovery triggers (0 disables, default: 900)' },
      },
      required: ['expression', 'prompt'],
    },
  };
}

export function getTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  registerBuiltInProviders();
  return [...getAllTools(), waitTool, abortTool, workflowTool()];
}

export const tools = getTools();

async function handleWaitTool(rawArgs: Record<string, unknown>, notify?: NotifyFn, progressToken?: string | number): Promise<McpResult> {
  const parsed = waitToolSchema.safeParse(rawArgs);
  if (!parsed.success) throw parsed.error;
  return handleWait(parsed.data, notify, progressToken);
}

function handleAbortTool(rawArgs: Record<string, unknown>): McpResult {
  const parsed = abortToolSchema.safeParse(rawArgs);
  if (!parsed.success) throw parsed.error;
  return handleBatchAbort(parsed.data.sessions);
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
    if (name === 'abort') return handleAbortTool(rawArgs);
    if (name === 'workflow') return handleWorkflow(rawArgs, handleToolCall, mgr, progressToken, notify);
    return textResult(`Unknown tool: ${name}`, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
