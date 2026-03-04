/**
 * Provider identifier: a lowercase-letter/digit/hyphen string matching `providerIdentPattern`.
 * Examples: "codex", "claude", "gemini", "my-provider".
 * Validated at registration boundaries; stored as-is in session files.
 */
export type SessionProvider = string;

export type ExecResult = {
  response: string;
  sessionId: string | null;
  model: string;
  durationMs: number;
  aborted: boolean;
  costUsd?: number;
  exitCode?: number | null;
  errors?: string[];
  warnings?: string[];
};

export type SessionEntry = {
  id: string;
  provider: SessionProvider;
  name: string;
  threadId: string;
  model: string;
  createdAt: string;
  lastUsedAt: string;
  workingDirectory: string;
};

export type CliExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type CompletionMetadata = {
  model?: string;
  aborted?: boolean;
  non_resumable?: boolean;
  exit_code?: number;
  errors?: unknown[];
  warnings?: unknown[];
  [k: string]: unknown;
};
