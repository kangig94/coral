import type { CodexThreadEvent } from './types.js';
import { formatToolProgress, shortPath, truncate } from '../../shared/format-progress.js';
import { stripShellWrapper, matchCommandPattern } from './command-patterns.js';
import { isRecord } from '../../shared/mcp-utils.js';

/** Extract a human-readable progress message from a Codex JSONL event. */
export function extractProgressMessage(event: CodexThreadEvent, projectRoot?: string): string | null {
  if (event.type === 'turn.started') return 'Processing...';
  if (event.type !== 'item.completed') return null;

  const item = event.item;
  switch (item.type) {
    case 'reasoning':
      return typeof item.text === 'string' ? truncate(item.text, 120) : null;
    case 'web_search':
      return typeof item.query === 'string'
        ? formatToolProgress('WebSearch', { query: item.query }, projectRoot)
        : null;
    case 'agent_message':
      return 'Generating response...';
    case 'command_execution': {
      if (typeof item.command !== 'string') return null;
      const stripped = stripShellWrapper(item.command);
      return matchCommandPattern(stripped, projectRoot)
        ?? formatToolProgress('Bash', { command: stripped }, projectRoot);
    }
    case 'file_change': {
      const firstChange = Array.isArray(item.changes) ? item.changes[0] : undefined;
      const path = typeof firstChange?.path === 'string' ? firstChange.path : 'file';
      const label = firstChange?.kind === 'created' ? 'Write' : 'Update';
      return `${label}(${shortPath(path, projectRoot)})`;
    }
    case 'mcp_tool_call': {
      if (typeof item.tool !== 'string') return null;
      const args = isRecord(item.arguments) ? item.arguments : {};
      return formatToolProgress(item.tool, args, projectRoot);
    }
    default:
      return null;
  }
}
