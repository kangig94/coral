/**
 * JSONL output parser for Codex CLI (--json mode).
 *
 * Codex emits one JSON object per line. We extract:
 * - thread.started → thread_id (session identifier)
 * - item.completed with item.type === "agent_message" → final response text
 * - turn.failed → error message
 * - error → fatal error message
 *
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
 * Extracts the thread ID and all agent message texts.
 */
export function parseCodexJsonl(output: string): ParsedCodexOutput {
  const lines = output.trim().split('\n').filter((l) => l.trim());
  const messages: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let threadId: string | null = null;
  // Track error messages for dedup: Codex emits identical messages as both
  // "error" and "turn.failed" events (see event_processor_with_jsonl_output.rs:164-169,790-794).
  // StreamError events also produce {"type":"error"} in JSONL but do NOT
  // set last_critical_error, so no subsequent turn.failed is emitted for those.
  const errorMessages = new Set<string>();

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // thread.started — extract thread_id (session identifier)
      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
        continue;
      }

      // item.completed — agent_message (response) or error (warning)
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && event.item.text) {
          messages.push(event.item.text);
        }
        if (event.item.type === 'error' && event.item.message) {
          warnings.push(event.item.message);
        }
        continue;
      }

      // error — fatal stream error (must come before turn.failed for dedup)
      // Note: StreamError events also appear as {"type":"error"} in JSONL
      // but may not cause non-zero exit code (lib.rs:552 only flags EventMsg::Error).
      if (event.type === 'error' && event.message) {
        errorMessages.add(event.message);
        errors.push(event.message);
        continue;
      }

      // turn.failed — skip if already collected via preceding error event
      if (event.type === 'turn.failed' && event.error?.message) {
        if (!errorMessages.has(event.error.message)) {
          errors.push(event.error.message);
        }
        continue;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return {
    response: messages.join('\n'),
    threadId,
    errors,
    warnings,
  };
}
