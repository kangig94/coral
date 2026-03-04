import { formatToolProgress } from '../../shared/format-progress.js';
import { isRecord } from '../../shared/mcp-utils.js';
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
    if (!isRecord(block)) continue;
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name && isRecord(block.input)) {
      return formatToolProgress(block.name, block.input);
    }
    if (block.type === 'text') return 'Generating response...';
  }

  return null;
}
