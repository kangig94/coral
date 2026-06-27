export const CORAL_CLAUDE_TRANSPORT_ENV = 'CORAL_CLAUDE_TRANSPORT';

export type ClaudeTransportMode = 'print' | 'tui';

const PRINT_ALIASES = new Set(['print', 'p', '-p', 'stream-json', 'stream_json', 'json']);
const TUI_ALIASES = new Set(['tui', 'pty', 'interactive']);

export function resolveClaudeTransportMode(env?: Readonly<Record<string, string | undefined>>): ClaudeTransportMode {
  const raw = env?.[CORAL_CLAUDE_TRANSPORT_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return 'print';
  }

  const normalized = raw.trim().toLowerCase();
  if (PRINT_ALIASES.has(normalized)) {
    return 'print';
  }
  if (TUI_ALIASES.has(normalized)) {
    return 'tui';
  }

  throw new Error(`${CORAL_CLAUDE_TRANSPORT_ENV} must be one of: print, stream-json, tui, pty. Received: ${raw}`);
}

export function claudeTransportEnv(mode: ClaudeTransportMode): Record<string, string> {
  return { [CORAL_CLAUDE_TRANSPORT_ENV]: mode };
}
