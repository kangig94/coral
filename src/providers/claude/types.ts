export type ClaudeExecResult = {
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  costUsd: number | null;
  aborted: boolean;
  isError?: boolean;
};

export type ClaudeJsonOutput = {
  type?: string;
  result?: unknown;
  session_id?: string;
  usage?: unknown;
  total_cost_usd?: number;
  model?: string;
  [key: string]: unknown;
};

export type ClaudeExecFailure = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parseError: string;
};

export type ClaudeStreamEvent = {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
    model?: string;
    usage?: unknown;
  };
  session_id?: string;
  total_cost_usd?: number;
  result?: unknown;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  [key: string]: unknown;
};
