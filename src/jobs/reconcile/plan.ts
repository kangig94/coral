import { isLivePhase, isTerminalPhase } from '../phase.js';
import type { JobLaunch, JobRuntime, JobStatus } from '../records.js';
import type { JobLifecycleFault, JobProgressFault } from '../outcome.js';

export type RecoveryJobFacts = {
  jobId: string;
  hasLaunchRequest: boolean;
  hasRuntimeStart: boolean;
  hasTerminalRecord: boolean;
  status: JobStatus | null;
  launchRecord: JobLaunch | null;
  runtimeRecord: JobRuntime | null;
};

export interface RecoveryProjectionSnapshot {
  readonly jobIds: readonly string[];
  readJob(jobId: string): RecoveryJobFacts;
  /**
   * Probes whether a durable pid is live. Dead provider runtimes still register
   * for BoundProvider recovery; dead non-provider runtimes use wrapper_lost.
   * Non-pid runtimes (app-server, internal kb) are never probed.
   */
  isPidAlive(pid: number): boolean;
}

export type RecoveryAction =
  | { type: 'discardIncompleteAdmission'; jobId: string }
  | { type: 'markError'; jobId: string; fault: JobLifecycleFault | JobProgressFault; status: JobStatus }
  | { type: 'resolvePreReadyLaunch'; jobId: string; launchRecord: JobLaunch; status: JobStatus }
  | { type: 'registerQueued'; jobId: string; launchRecord: JobLaunch }
  | {
      type: 'registerRunning';
      jobId: string;
      launchRecord: JobLaunch;
      runtimeRecord: JobRuntime;
    };

type RegisterAction = Extract<RecoveryAction, { type: 'registerRunning' | 'registerQueued' }>;
type CleanupAction = Exclude<RecoveryAction, { type: 'registerRunning' | 'registerQueued' }>;

export type RecoveryPlan = {
  register: RegisterAction[];
  cleanup: CleanupAction[];
};

type PlannedRecoveryAction = {
  bucket: 'running' | 'staleDead' | 'queued' | 'discardIncompleteAdmission' | 'missingLaunchRecord' | 'staleRunning';
  action: RecoveryAction;
};

export function planRecovery(snapshot: RecoveryProjectionSnapshot): RecoveryPlan {
  const jobIds = readJobIds(snapshot.jobIds);
  const registerRunning: RegisterAction[] = [];
  const registerQueued: Array<Extract<RecoveryAction, { type: 'registerQueued' }>> = [];
  const discardIncompleteAdmission: CleanupAction[] = [];
  const markMissingLaunchRecord: CleanupAction[] = [];
  const markStaleRunning: CleanupAction[] = [];

  for (const jobId of jobIds) {
    const planned = planJobRecovery(snapshot.readJob(jobId), (pid) => snapshot.isPidAlive(pid));
    if (planned === null) continue;

    switch (planned.bucket) {
      case 'running':
      case 'staleDead':
        registerRunning.push(planned.action as RegisterAction);
        break;
      case 'queued':
        registerQueued.push(planned.action as Extract<RecoveryAction, { type: 'registerQueued' }>);
        break;
      case 'discardIncompleteAdmission':
        discardIncompleteAdmission.push(planned.action as CleanupAction);
        break;
      case 'missingLaunchRecord':
        markMissingLaunchRecord.push(planned.action as CleanupAction);
        break;
      case 'staleRunning':
        markStaleRunning.push(planned.action as CleanupAction);
        break;
    }
  }

  registerQueued.sort((left, right) => left.launchRecord.enqueueSequence - right.launchRecord.enqueueSequence);

  return {
    register: [...registerRunning, ...registerQueued],
    cleanup: [
      ...discardIncompleteAdmission,
      ...markMissingLaunchRecord,
      ...markStaleRunning,
    ],
  };
}

function planJobRecovery(facts: RecoveryJobFacts, isPidAlive: (pid: number) => boolean): PlannedRecoveryAction | null {
  const status = facts.status;

  if (status === null) {
    return facts.hasLaunchRequest
      ? {
          bucket: 'discardIncompleteAdmission',
          action: { type: 'discardIncompleteAdmission', jobId: facts.jobId },
        }
      : null;
  }

  if (status.finishing === true || isTerminalPhase(status.phase)) {
    return null;
  }

  if (isLivePhase(status.phase) && !facts.hasLaunchRequest) {
    if (status.jobKind === 'workflow') {
      return null;
    }

    return {
      bucket: 'missingLaunchRecord',
      action: {
        type: 'markError',
        jobId: facts.jobId,
        fault: { kind: 'missing_launch_record' },
        status,
      },
    };
  }

  if (isLivePhase(status.phase) && status.jobKind === 'kb') {
    return {
      bucket: 'staleRunning',
      action: {
        type: 'markError',
        jobId: facts.jobId,
        fault: { kind: 'wrapper_lost' },
        status,
      },
    };
  }

  if (isLivePhase(status.phase) && status.jobKind === 'workflow') {
    return null;
  }

  if (facts.hasLaunchRequest && status.phase === 'queued' && !facts.hasRuntimeStart) {
    if (facts.launchRecord?.parentWorkflowJobId !== undefined) {
      return {
        bucket: 'staleRunning',
        action: {
          type: 'markError',
          jobId: facts.jobId,
          fault: { kind: 'ghost_launch' },
          status,
        },
      };
    }
    return facts.launchRecord === null
      ? null
      : {
          bucket: 'queued',
          action: {
            type: 'registerQueued',
            jobId: facts.jobId,
            launchRecord: facts.launchRecord,
          },
        };
  }

  if (
    facts.hasLaunchRequest &&
    !facts.hasRuntimeStart &&
    (status.phase === 'launching' || status.phase === 'running')
  ) {
    if (facts.launchRecord === null) return null;
    return {
      bucket: 'staleRunning',
      action: {
        type: 'resolvePreReadyLaunch',
        jobId: facts.jobId,
        launchRecord: facts.launchRecord,
        status,
      },
    };
  }

  if (facts.hasLaunchRequest && facts.hasRuntimeStart && (status.phase === 'launching' || status.phase === 'running')) {
    if (facts.launchRecord === null || facts.runtimeRecord === null) {
      return null;
    }

    // Provider durable runtimes must still pass through captured BoundProvider
    // recovery after the process dies: the provider owns artifact parsing and
    // the terminal/continuity decision. Non-provider runtimes have no such
    // recovery authority and retain the generic wrapper_lost fallback.
    const pid = readDurableRuntimePid(facts.runtimeRecord);
    if (pid !== null && status.jobKind !== 'provider' && !isPidAlive(pid)) {
      return {
        bucket: 'staleRunning',
        action: {
          type: 'markError',
          jobId: facts.jobId,
          fault: { kind: 'wrapper_lost' },
          status,
        },
      };
    }

    return {
      bucket: facts.hasTerminalRecord ? 'staleDead' : 'running',
      action: {
        type: 'registerRunning',
        jobId: facts.jobId,
        launchRecord: facts.launchRecord,
        runtimeRecord: facts.runtimeRecord,
      },
    };
  }

  return null;
}

function readDurableRuntimePid(runtime: JobRuntime): number | null {
  // Durable-cli runtime records carry a numeric pid; app-server and internal
  // kb runtimes do not. The planner only probes pids it has.
  if ('pid' in runtime && typeof runtime.pid === 'number') {
    return runtime.pid;
  }
  return null;
}

function readJobIds(jobIds: readonly string[]): string[] {
  if (!Array.isArray(jobIds)) return [];
  return jobIds.filter((jobId): jobId is string => typeof jobId === 'string');
}

