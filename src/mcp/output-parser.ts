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
  const lines = output.trim().split('\n').filter((l) => l.trim());
  const messages: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let threadId: string | null = null;
  const seenErrors = new Set<string>();

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
        continue;
      }

      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && event.item.text) {
          messages.push(event.item.text);
        }
        if (event.item.type === 'error' && event.item.message) {
          warnings.push(event.item.message);
        }
        continue;
      }

      if (event.type === 'error' && event.message) {
        seenErrors.add(event.message);
        errors.push(event.message);
        continue;
      }

      if (event.type === 'turn.failed' && event.error?.message) {
        if (!seenErrors.has(event.error.message)) {
          errors.push(event.error.message);
        }
        continue;
      }
    } catch {
      // Non-JSON lines (debug output) are ignored
    }
  }

  return {
    response: messages.join('\n'),
    threadId,
    errors,
    warnings,
  };
}
