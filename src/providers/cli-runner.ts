import { durableCliFailureDomainName } from '../infra/failure-domain.js';
import { type DurableCliRuntimeRecord, isDurableCliRuntime } from '../runtime/durable-runtime.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableProvisionalProcessSubject,
} from '../runtime/ports.js';
import type { LaunchPermit, LaunchPool } from '../jobs/contracts/admission.js';
import type { ExecutionAddress } from '../jobs/execution-address.js';
import type { AbortHoldDisposition, AbortHoldOwner } from '../jobs/contracts/abort-registry.js';
import type { ProviderCliRunner } from './protocol.js';

export type DurableContainmentOperatorControl = Readonly<{
  retry(): void;
  abandon(): AbortHoldDisposition;
}>;

export type DurableProcessPublicationDisposition =
  | Readonly<{ kind: 'published'; failureDomainReady?: boolean; failureDomainEntered?: boolean }>
  | Readonly<{ kind: 'retained'; reason: string }>;

export type DurableProcessIdentityCallback = (
  identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
  status?: DurableContainmentStatus,
  control?: DurableContainmentOperatorControl,
  placement?: 'entered',
) => DurableProcessPublicationDisposition;

export type DurableLaunchCallerOwnership = Readonly<{
  permit: LaunchPermit;
  abortHoldOwner: AbortHoldOwner;
}>;

export interface ProviderDurableSpawner {
  spawnDurableJob(options: {
    provider: string;
    command: string;
    args: string[];
    prompt?: string;
    cwd?: string;
    onEvent?: (line: string) => void;
    signal?: AbortSignal;
    callerOwnership?: DurableLaunchCallerOwnership;
    pool?: LaunchPool;
    extraEnv?: Record<string, string>;
    exactEnv?: Record<string, string>;
    jobDir: string;
    jobId?: string;
    failureDomainName: string;
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
  executionAddress: ExecutionAddress,
  onRuntimeRecord?: (record: DurableCliRuntimeRecord, provisionalIdentity?: DurableProvisionalProcessSubject) => void,
  onDurableProcessIdentity?: DurableProcessIdentityCallback,
  callerOwnership?: DurableLaunchCallerOwnership,
): ProviderCliRunner {
  return (request) =>
    launchCoordinator.spawnDurableJob({
      provider,
      signal,
      pool,
      jobDir,
      failureDomainName: durableCliFailureDomainName(executionAddress.jobId, executionAddress.execution),
      jobId: executionAddress.jobId,
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
      ...(callerOwnership === undefined ? {} : { callerOwnership }),
    });
}
