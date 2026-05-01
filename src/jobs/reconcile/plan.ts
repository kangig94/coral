import { isLivePhase, isTerminalPhase } from '../phase.js';
import { belongsToNamespace, type JobLaunch, type JobRuntime, type JobStatus } from '../records.js';
import type { JobLifecycleFault, JobProgressFault } from '../outcome.js';

/**
 * Invariant — jobIds freshness:
 * `jobIds` mirrors `progressStore.listJobIds()` at snapshot construction time.
 * Recovery planning does not delete jobs between snapshot build and planning, so
 * `jobIds.includes(activeJobId)` preserves the active projection membership
 * semantics for orphaned session-claim detection.
 *
 * Invariant — session state crosses namespaces:
 * `listSessionRefs()` / `readSession(...)` enumerate Journal-projected sessions
 * regardless of `currentNamespace`, matching the current lifecycle session sweep.
 * Terminal and orphaned claims must remain releasable even when the owning job
 * belongs to a foreign namespace.
 */
export type RecoveryJobFacts = {
  jobId: string;
  hasLaunchRequest: boolean;
  hasRuntimeStart: boolean;
  hasTerminalRecord: boolean;
  status: JobStatus | null;
  launchRecord: JobLaunch | null;
  runtimeRecord: JobRuntime | null;
};

export type RecoverySessionFacts = {
  activeJobId?: string;
};

export interface RecoveryProjectionSnapshot {
  readonly jobIds: readonly string[];
  readonly currentNamespace: string;
  readJob(jobId: string): RecoveryJobFacts;
  listSessionRefs(): Array<{ sessionId: string; provider: string }>;
  readSession(sessionId: string): RecoverySessionFacts | null;
  /**
   * Probes whether the given pid is still live. Mirrors the cross-namespace
   * adoption probe (§12.1): a same-namespace `running` / `launching` job whose
   * pid is gone is wrapper_lost, not a recoverable runtime. Returning `true`
   * for non-pid runtimes (app-server, internal kb) is safe — the planner
   * only consults this for durable-cli runtimes that carry a pid.
   */
  isPidAlive(pid: number): boolean;
}

export type RecoveryAction =
  | { type: 'discardIncompleteAdmission'; jobId: string }
  | { type: 'markError'; jobId: string; fault: JobLifecycleFault | JobProgressFault; status: JobStatus }
  | { type: 'registerQueued'; jobId: string; launchRecord: JobLaunch }
  | {
      type: 'registerRunning';
      jobId: string;
      launchRecord: JobLaunch;
      runtimeRecord: JobRuntime;
    }
  | { type: 'releaseSessionClaim'; sessionId: string; jobId: string };

export type RegisterAction = Extract<RecoveryAction, { type: 'registerRunning' | 'registerQueued' }>;
export type CleanupAction = Exclude<RecoveryAction, { type: 'registerRunning' | 'registerQueued' }>;

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
    const planned = planJobRecovery(snapshot.readJob(jobId), snapshot.currentNamespace, (pid) =>
      snapshot.isPidAlive(pid),
    );
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
      ...planSessionClaimReleases(snapshot, jobIds),
    ],
  };
}

function planJobRecovery(
  facts: RecoveryJobFacts,
  currentNamespace: string,
  isPidAlive: (pid: number) => boolean,
): PlannedRecoveryAction | null {
  const status = facts.status;

  if (status === null) {
    return facts.hasLaunchRequest
      ? {
          bucket: 'discardIncompleteAdmission',
          action: { type: 'discardIncompleteAdmission', jobId: facts.jobId },
        }
      : null;
  }

  if (!belongsToNamespace(status, currentNamespace) || isTerminalPhase(status.phase)) {
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

  if (facts.hasLaunchRequest && facts.hasRuntimeStart && (status.phase === 'launching' || status.phase === 'running')) {
    if (facts.launchRecord === null || facts.runtimeRecord === null) {
      return null;
    }

    // Spec §12.1: a projected `running` / `launching` job whose pid is gone
    // is wrapper_lost, not recoverable runtime. Cross-namespace adoption
    // already enforces this for foreign jobs; same-namespace probes here so
    // a dead pid does not silently re-register and stick the job forever.
    const pid = readDurableRuntimePid(facts.runtimeRecord);
    if (pid !== null && !isPidAlive(pid)) {
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

function planSessionClaimReleases(snapshot: RecoveryProjectionSnapshot, jobIds: readonly string[]): CleanupAction[] {
  const knownJobIds = new Set(jobIds);
  const actions: CleanupAction[] = [];

  for (const ref of readSessionRefs(snapshot)) {
    const session = snapshot.readSession(ref.sessionId);
    const activeJobId = session?.activeJobId;
    if (!activeJobId) continue;

    if (!knownJobIds.has(activeJobId)) {
      actions.push({
        type: 'releaseSessionClaim',
        sessionId: ref.sessionId,
        jobId: activeJobId,
      });
      continue;
    }

    const activeJob = snapshot.readJob(activeJobId);
    if (activeJob.status !== null && isTerminalPhase(activeJob.status.phase)) {
      actions.push({
        type: 'releaseSessionClaim',
        sessionId: ref.sessionId,
        jobId: activeJobId,
      });
    }
  }

  return actions;
}

function readJobIds(jobIds: readonly string[]): string[] {
  if (!Array.isArray(jobIds)) return [];
  return jobIds.filter((jobId): jobId is string => typeof jobId === 'string');
}

function readSessionRefs(snapshot: RecoveryProjectionSnapshot): Array<{ sessionId: string; provider: string }> {
  const refs = snapshot.listSessionRefs();
  if (!Array.isArray(refs)) return [];

  return refs.filter(
    (ref): ref is { sessionId: string; provider: string } =>
      ref !== null && typeof ref === 'object' && typeof ref.sessionId === 'string' && typeof ref.provider === 'string',
  );
}
