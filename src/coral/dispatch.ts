import { getProvider } from '../providers/registry.js';
import type { NotifyFn } from '../providers/types.js';
import type { SessionManager } from '../runner/session-manager.js';
import { type McpResult, textResult } from '../shared/mcp-utils.js';
import { CORAL_DEFAULT_EFFORT } from '../shared/schemas.js';
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

  const rawOp = rawArgs.op;
  if (typeof rawOp !== 'string' || !rawOp.startsWith(CORAL_OP_PREFIX)) {
    return textResult(`Invalid coral op: ${String(rawOp ?? '')}`, true);
  }

  const coralName = rawOp.slice(CORAL_OP_PREFIX.length);
  const { content } = resolveCoralContent(coralName);

  const argsWithEffort = 'effort' in rawArgs
    ? rawArgs
    : { ...rawArgs, effort: CORAL_DEFAULT_EFFORT };

  return provider.handleCoralOp(coralName, content, argsWithEffort, mgr, progressToken, notify);
}
