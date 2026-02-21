/**
 * JSONL output parser for Codex CLI (--json mode).
 * Ref: codex-rs/exec/src/exec_events.rs
 */

export interface ParsedCodexOutput {
  response: string;
  threadId: string | null;
  errors: string[];
  warnings: string[];
}

/**
 * Parse Codex JSONL output in a single pass.
 *
 * Codex emits identical messages as both "error" and "turn.failed" events,
 * so we deduplicate them via a Set.
 */
export function parseCodexJsonl(output: string): ParsedCodexOutput {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  const messages: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let threadId: string | null = null;
  const seenErrors = new Set<string>();

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON lines (debug output) are ignored
      continue;
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
      continue;
    }

    if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        messages.push(item.text);
      }
      if (item.type === 'error' && typeof item.message === 'string') {
        warnings.push(item.message);
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
      const failMessage = (event as { error?: { message?: unknown } }).error?.message;
      if (typeof failMessage === 'string' && !seenErrors.has(failMessage)) {
        errors.push(failMessage);
      }
      continue;
    }
  }

  return {
    response: messages.join('\n'),
    threadId,
    errors,
    warnings,
  };
}
