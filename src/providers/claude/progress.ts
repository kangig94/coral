import { formatToolProgress } from '../../shared/format-progress.js';
import type { ClaudeStreamEvent } from './types.js';

export {
  createSessionDir,
  writeSessionResult,
  writeSessionError,
  readSessionStatus,
  resolveSessionDir,
  formatElapsed,
  appendProgressEvent,
  SESSIONS_DIR,
  PROGRESS_FILE,
  type SessionStatus,
} from '../../runner/progress.js';

export function extractClaudeProgressMessage(event: ClaudeStreamEvent): string | null {
  if (event.type !== 'assistant') return null;

  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  for (const block of content) {
    if (!isBlock(block)) continue;
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name && isRecord(block.input)) {
      return formatToolProgress(block.name, block.input);
    }
    if (block.type === 'text') return 'Generating response...';
  }

  return null;
}

function isBlock(block: unknown): block is { type: string; name?: string; input?: unknown; text?: string } {
  return typeof block === 'object' && block !== null && 'type' in block;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
