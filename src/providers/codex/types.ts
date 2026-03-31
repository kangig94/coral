/** Codex provider-specific type definitions. */

/** Result from a single Codex CLI execution */
export type CodexExecResult = {
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  exitCode: number | null;
  errors: string[];
  warnings: string[];
  /** true when execution was aborted via AbortSignal */
  aborted: boolean;
};

/**
 * Codex JSONL event types (matches codex-rs/exec/src/exec_events.rs).
 *
 * ThreadEvent is the top-level envelope, tagged by "type".
 */
export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexThreadItem }
  | { type: 'item.updated'; item: CodexThreadItem }
  | { type: 'item.completed'; item: CodexThreadItem }
  | { type: 'error'; message: string };

/**
 * ThreadItem - flattened representation of a thread item.
 * The `type` field discriminates the payload (serde flatten + tag = "type").
 */
export type CodexThreadItem = { id: string } & CodexThreadItemDetails;

export type CodexThreadItemDetails =
  | { type: 'agent_message'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'command_execution'; command: string; aggregated_output: string; exit_code: number | null; status: string }
  | { type: 'file_change'; changes: Array<{ path: string; kind: string }>; status: string }
  | {
      type: 'mcp_tool_call';
      server: string;
      tool: string;
      arguments: unknown;
      result: unknown;
      error: unknown;
      status: string;
    }
  | {
      type: 'collab_tool_call';
      tool: string;
      sender_thread_id: string;
      receiver_thread_ids: string[];
      prompt: string | null;
      status: string;
    }
  | { type: 'web_search'; query: string; action: unknown }
  | { type: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { type: 'error'; message: string }
  | { type: string; [key: string]: unknown };
