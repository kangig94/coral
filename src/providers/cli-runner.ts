import type { LaunchCoordinator, LaunchPool } from '../jobs/shell/contracts.js';
import type { JobRuntime } from '../jobs/views.js';
import { isDurableCliRuntime, type DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';

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

export function bindProviderRunner(
  launchCoordinator: Pick<LaunchCoordinator, 'spawnDurableJob'>,
  provider: string,
  signal: AbortSignal,
  pool: LaunchPool,
  jobDir: string,
  onRuntimeRecord?: (record: JobRuntime) => void,
): ProviderCliRunner {
  return (request) =>
    launchCoordinator.spawnDurableJob({
      provider,
      signal,
      permitGranted: true,
      pool,
      jobDir,
      command: request.command,
      args: request.args,
      prompt: request.prompt,
      cwd: request.cwd,
      extraEnv: request.extraEnv,
      onEvent: request.onEvent,
      onRuntimeRecord: (record) => {
        if (isDurableCliRuntime(record)) {
          request.onRuntimeRecord?.(record);
        }
        onRuntimeRecord?.(record);
      },
    });
}
