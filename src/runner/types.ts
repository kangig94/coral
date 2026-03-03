export type SessionProvider = 'codex' | 'claude';

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
