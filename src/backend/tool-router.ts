import { CORAL_OP_PREFIX, handleCoralDispatch } from '../coral/dispatch.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { getProvider } from '../providers/registry.js';
import { handleBatchAbort } from '../providers/session-ops.js';
import { SessionManager } from '../runner/session-manager.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { handleWorkflow } from '../workflow/handler.js';
import type { CallerContext } from './request-context.js';

function defaultExecutionArgs(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string,
): Record<string, unknown> {
  if (typeof args.working_directory === 'string') return args;
  const rawOp = args.op;
  const hasSession = typeof args.session === 'string';
  if (toolName !== 'codex' && toolName !== 'claude') return args;
  if (rawOp === 'exec' && !hasSession) {
    return { ...args, working_directory: projectRoot };
  }
  if (typeof rawOp === 'string' && rawOp.startsWith(CORAL_OP_PREFIX) && !hasSession) {
    return { ...args, working_directory: projectRoot };
  }
  return args;
}

export async function routeBackendToolCall(
  name: string,
  args: Record<string, unknown>,
  context: CallerContext,
): Promise<McpResult> {
  if (name === 'wait') {
    return textResult('wait is not handled by the backend', true);
  }

  const mgr = new SessionManager(context.projectRoot);

  try {
    registerBuiltInProviders();
    const provider = getProvider(name);
    if (provider) {
      const normalizedArgs = defaultExecutionArgs(name, args, context.projectRoot);
      const rawOp = normalizedArgs.op;
      if (typeof rawOp === 'string' && rawOp.startsWith(CORAL_OP_PREFIX)) {
        return await handleCoralDispatch(name, normalizedArgs, mgr);
      }
      return await provider.handleOp(normalizedArgs, mgr);
    }
    if (name === 'abort') {
      return handleBatchAbort((args as { sessions?: unknown[] }).sessions as string[]);
    }
    if (name === 'workflow') {
      return handleWorkflow(
        args,
        (toolName, toolArgs) => routeBackendToolCall(toolName, toolArgs, context),
        mgr,
        context.projectRoot,
      );
    }
    return textResult(`Unknown tool: ${name}`, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Backend tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
