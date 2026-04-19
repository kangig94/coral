import type { DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';

export type ProviderCliRequest = {
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  extraEnv?: Record<string, string>;
  onEvent?: (line: string) => void;
  onRuntimeRecord?: (record: DurableCliRuntimeRecord) => void;
};

export type ProviderCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type ProviderCliRunner = (request: ProviderCliRequest) => Promise<ProviderCliResult>;
