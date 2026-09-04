import { type DurableCliRuntimeRecord, isDurableCliRuntime } from '../runtime/durable-runtime.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableProvisionalProcessSubject,
} from '../runtime/ports.js';
import type { LaunchPool } from '../jobs/contracts/admission.js';
import type { ProviderCliRunner } from './protocol.js';

export type DurableContainmentOperatorControl = Readonly<{
  retry(): void;
  abandon(): boolean;
}>;

export type DurableProcessIdentityCallback = (
  identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
  status?: DurableContainmentStatus,
  control?: DurableContainmentOperatorControl,
) => void;

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
    onRuntimeRecord?: (record: DurableCliRuntimeRecord, provisionalIdentity?: DurableProvisionalProcessSubject) => void;
    onDurableProcessIdentity?: DurableProcessIdentityCallback;
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
  onRuntimeRecord?: (record: DurableCliRuntimeRecord, provisionalIdentity?: DurableProvisionalProcessSubject) => void,
  onDurableProcessIdentity?: DurableProcessIdentityCallback,
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
      onRuntimeRecord: (record, provisionalIdentity) => {
        if (isDurableCliRuntime(record)) {
          request.onRuntimeRecord?.(record);
        }
        onRuntimeRecord?.(record, provisionalIdentity);
      },
      onDurableProcessIdentity,
    });
}
