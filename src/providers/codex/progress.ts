import type { CodexThreadEvent } from './types.js';
import { shortPath, truncate } from '../../shared/format-progress.js';
import { stripShellWrapper, matchCommandPattern } from './command-patterns.js';

function formatCommandExecution(command: string, projectRoot?: string): string {
  const stripped = stripShellWrapper(command);
  return matchCommandPattern(stripped, projectRoot) ?? `Bash(${truncate(stripped)})`;
}

function formatFileChange(path: string | undefined, projectRoot?: string): string {
  return `Edit(${shortPath(path ?? 'file', projectRoot)})`;
}

/** Extract a human-readable progress message from a Codex JSONL event. */
export function extractProgressMessage(event: CodexThreadEvent, projectRoot?: string): string | null {
  if (event.type === 'turn.started') return 'Processing...';
  if (event.type !== 'item.completed') return null;

  const item = event.item;
  switch (item.type) {
    case 'reasoning':
      return typeof item.text === 'string' ? item.text.slice(0, 120) : null;
    case 'web_search':
      return typeof item.query === 'string' ? `Searching: ${item.query}` : null;
    case 'agent_message':
      return 'Generating response...';
    case 'command_execution':
      return typeof item.command === 'string' ? formatCommandExecution(item.command, projectRoot) : null;
    case 'file_change': {
      const firstChange = Array.isArray(item.changes) ? item.changes[0] : undefined;
      return formatFileChange(typeof firstChange?.path === 'string' ? firstChange.path : undefined, projectRoot);
    }
    case 'mcp_tool_call':
      return typeof item.tool === 'string' ? `Calling: ${item.tool}` : null;
    default:
      return null;
  }
}
