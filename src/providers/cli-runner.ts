import type { LaunchCoordinator, LaunchPool } from '../jobs/shell/contracts.js';
import type { JobRuntime } from '../jobs/records.js';
import { isDurableCliRuntime } from '../runtime/durable-runtime.js';
import type { ProviderCliRunner } from './protocol.js';
export type { ProviderCliRequest, ProviderCliResult, ProviderCliRunner } from './protocol.js';

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
