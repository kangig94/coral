import { type DurableCliRuntimeRecord, isDurableCliRuntime } from '../runtime/durable-runtime.js';
import type { LaunchPool } from '../jobs/contracts/admission.js';
import type { ProviderCliRunner } from './protocol.js';

export interface ProviderDurableSpawner {
  spawnDurableJob(options: {
    provider: string;
    command: string;
    args: string[];
    prompt?: string;
    cwd?: string;
    onEvent?: (line: string) => void;
    signal?: AbortSignal;
    permitGranted?: boolean;
    pool?: LaunchPool;
    extraEnv?: Record<string, string>;
    exactEnv?: Record<string, string>;
    jobDir: string;
    onRuntimeRecord?: (record: DurableCliRuntimeRecord) => void;
    /**
     * Mirrors `SpawnDurableJobOptions.onDurableProcessIdentity` (`coordinator/live/durable-transport.ts`)
     * field-for-field rather than importing it: this interface is the providers-domain seam, and reaching
     * into `coordinator/live/` for one callback shape would put a provider adapter on coordinator internals.
     */
    onDurableProcessIdentity?: (identity: { pid: number; processStartedAtSeconds: number }) => void;
  }): Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    aborted: boolean;
  }>;
}

export function bindProviderRunner(
  launchCoordinator: ProviderDurableSpawner,
  provider: string,
  signal: AbortSignal,
  pool: LaunchPool,
  jobDir: string,
  onRuntimeRecord?: (record: DurableCliRuntimeRecord) => void,
  onDurableProcessIdentity?: (identity: { pid: number; processStartedAtSeconds: number }) => void,
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
      exactEnv: request.exactEnv,
      onEvent: request.onEvent,
      onRuntimeRecord: (record) => {
        if (isDurableCliRuntime(record)) {
          request.onRuntimeRecord?.(record);
        }
        onRuntimeRecord?.(record);
      },
      onDurableProcessIdentity,
    });
}
