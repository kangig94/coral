import { getProvider } from '../providers/registry.js';
import type { NotifyFn } from '../providers/types.js';
import type { SessionManager } from '../runner/session-manager.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { resolveCoralContent } from './resolver.js';

export const CORAL_OP_PREFIX = 'coral:';

export async function handleCoralDispatch(
  toolName: string,
  rawArgs: Record<string, unknown>,
  mgr: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
): Promise<McpResult> {
  const provider = getProvider(toolName);
  if (!provider) return textResult(`Unknown provider: ${toolName}`, true);

  const op = (rawArgs as { op?: unknown }).op;
  if (typeof op !== 'string' || !op.startsWith(CORAL_OP_PREFIX)) {
    return textResult(`Invalid coral op: ${String(op ?? '')}`, true);
  }

  const coralName = op.slice(CORAL_OP_PREFIX.length);
  const resolved = resolveCoralContent(coralName);

  return provider.handleCoralOp(coralName, resolved.content, rawArgs, mgr, progressToken, notify);
}
