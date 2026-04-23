import { formatToolProgress } from '../../infra/format-progress.js';
import { isRecord } from '../../infra/json.js';
import type { ClaudeStreamEvent } from './types.js';

export function extractClaudeProgressMessage(event: ClaudeStreamEvent, projectRoot?: string): string | null {
  if (event.type !== 'assistant') return null;

  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name && isRecord(block.input)) {
      return formatToolProgress(block.name, block.input, projectRoot);
    }
    if (block.type === 'text') return 'Generating response...';
  }

  return null;
}
