/**
 * Codex-specific progress helpers.
 * Generic session/progress file helpers live in ../../runner/progress.ts.
 */

import { basename } from 'node:path';
import type { CodexThreadEvent } from '../../types.js';
import { truncate } from '../../shared/format-progress.js';
import { stripShellWrapper, matchCommandPattern } from './command-patterns.js';

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

/** Extract a human-readable progress message from a Codex JSONL event. */
export function extractProgressMessage(event: CodexThreadEvent): string | null {
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
    case 'command_execution': {
      if (typeof item.command !== 'string') return null;
      const stripped = stripShellWrapper(item.command);
      const matched = matchCommandPattern(stripped);
      return matched ?? `Bash(${truncate(stripped)})`;
    }
    case 'file_change': {
      const firstChange = Array.isArray(item.changes) ? item.changes[0] : undefined;
      const filePath = typeof firstChange?.path === 'string' ? firstChange.path : 'file';
      return `Edit(${basename(filePath)})`;
    }
    case 'mcp_tool_call':
      return typeof item.tool === 'string' ? `Calling: ${item.tool}` : null;
    default:
      return null;
  }
}
