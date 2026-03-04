/**
 * JSONL output parser for Codex CLI (--json mode).
 * Ref: codex-rs/exec/src/exec_events.rs
 */

export interface ParsedCodexOutput {
  response: string;
  sessionId: string | null;
  errors: string[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse Codex JSONL output in a single pass.
 *
 * Codex emits identical messages as both "error" and "turn.failed" events,
 * so we deduplicate them via a Set.
 */
export function parseCodexJsonl(output: string): ParsedCodexOutput {
  const messages: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let sessionId: string | null = null;
  const seenErrors = new Set<string>();

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON lines (debug output) are ignored
      continue;
    }
    if (!isRecord(event)) continue;

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id; // CLI boundary: map Codex thread_id to our sessionId
      continue;
    }

    if (event.type === 'item.completed' && isRecord(event.item)) {
      const item = event.item;
      switch (item.type) {
        case 'agent_message':
          if (typeof item.text === 'string') messages.push(item.text);
          break;
        case 'error':
          if (typeof item.message === 'string') warnings.push(item.message);
          break;
        default:
          break;
      }
      continue;
    }

    if (event.type === 'error' && typeof event.message === 'string') {
      const errorMessage = event.message;
      seenErrors.add(errorMessage);
      errors.push(errorMessage);
      continue;
    }

    if (event.type === 'turn.failed') {
      const eventError = isRecord(event.error) ? event.error : null;
      const failMessage = typeof eventError?.message === 'string' ? eventError.message : null;
      if (failMessage !== null && !seenErrors.has(failMessage)) {
        errors.push(failMessage);
      }
      continue;
    }
  }

  return {
    response: messages.join('\n'),
    sessionId,
    errors,
    warnings,
  };
}
