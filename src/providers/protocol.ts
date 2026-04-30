import type { AbortReason } from '../jobs/outcome.js';

export type { AbortReason };

export type ProviderCliRequest = {
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  extraEnv?: Record<string, string>;
  onEvent?: (line: string) => void;
  onRuntimeRecord?: (record: unknown) => void;
};

export type ProviderCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type ProviderCliRunner = (request: ProviderCliRequest) => Promise<ProviderCliResult>;

export type AppServerSubscriptionPhase = 'beforeInitialize' | 'afterInitialize';

export type AppServerNotificationMessage = {
  method: string;
  params?: Record<string, unknown>;
};

export type ProviderTransportClose = {
  kind: 'transport_closed';
  error?: Error | null;
};
