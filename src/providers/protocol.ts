export type ProviderCliRequest = {
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  extraEnv?: Record<string, string>;
  exactEnv?: Record<string, string>;
  onEvent?: (line: string) => void;
  onRuntimeRecord?: (record: unknown) => void;
};

type ProviderCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type ProviderCliRunner = (request: ProviderCliRequest) => Promise<ProviderCliResult>;

export type AppServerNotificationMessage = {
  method: string;
  params?: Record<string, unknown>;
};

export type ProviderTransportClose = {
  kind: 'transport_closed';
  error?: Error | null;
};
