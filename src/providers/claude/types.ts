export type ClaudeExecResult = {
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  costUsd: number;
  aborted: boolean;
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
