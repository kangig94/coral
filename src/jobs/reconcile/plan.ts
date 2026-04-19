import { isLivePhase, isTerminalPhase } from '../phase.js';
import { belongsToNamespace } from '../records.js';
import type { JobLaunchRecord, JobRuntimeRecord, JobStatusRecord, JobTerminalRecord } from '../records.js';
import type { JobExitRecord } from '../../runtime/durable-runtime.js';
import type { SessionEntry } from '../../sessions/entry.js';
import type { RecoveryFaultCompat } from '../../shared/legacy-terminal-outcome-compat.js';

/**
 * Invariant — jobIds freshness:
 * `jobIds` mirrors `progressStore.listJobIds()` at snapshot construction time.
 * Recovery planning does not delete jobs between snapshot build and planning, so
 * `jobIds.includes(activeJobId)` preserves the active path's `hasJobDir(...)`
 * semantics for orphaned session-claim detection.
 *
 * Invariant — session state crosses namespaces:
 * `listSessionRefs()` / `readSession(...)` enumerate sessions across all shards
 * regardless of `currentNamespace`, matching the current lifecycle session sweep.
 * Terminal and orphaned claims must remain releasable even when the owning job
 * belongs to a foreign namespace.
 */
export interface JobStoreSnapshot {
  readonly jobIds: readonly string[];
  readonly currentNamespace: string;
  hasLaunch(jobId: string): boolean;
  hasRuntime(jobId: string): boolean;
  hasExit(jobId: string): boolean;
  readStatus(jobId: string): JobStatusRecord | null;
  readLaunch(jobId: string): JobLaunchRecord | null;
  readRuntime(jobId: string): JobRuntimeRecord | null;
  readExit(jobId: string): JobExitRecord | null;
  readTerminalPayload(jobId: string): JobTerminalRecord | null;
  listSessionRefs(): Array<{ shardDir: string; sessionId: string; provider: string }>;
  readSession(shardDir: string, provider: string, sessionId: string): SessionEntry | null;
}

export type RecoveryAction =
  | { type: 'deleteIncompleteDir'; jobId: string }
  | { type: 'markError'; jobId: string; fault: RecoveryFaultCompat; status: JobStatusRecord }
  | { type: 'registerQueued'; jobId: string; launchRecord: JobLaunchRecord }
  | {
      type: 'registerRunning';
      jobId: string;
      launchRecord: JobLaunchRecord;
      runtimeRecord: JobRuntimeRecord;
    }
  | { type: 'releaseSessionClaim'; shardDir: string; sessionId: string; jobId: string };

export type RegisterAction = Extract<RecoveryAction, { type: 'registerRunning' | 'registerQueued' }>;
export type CleanupAction = Exclude<RecoveryAction, { type: 'registerRunning' | 'registerQueued' }>;

export type RecoveryPlan = {
  register: RegisterAction[];
  cleanup: CleanupAction[];
};

type RecoveryJobRow = {
  jobId: string;
  hasLaunch: boolean;
  hasRuntime: boolean;
  hasExit: boolean;
  status: JobStatusRecord | null;
  launchRecord: JobLaunchRecord | null;
  runtimeRecord: JobRuntimeRecord | null;
  exitRecord: JobExitRecord | null;
  terminalPayload: JobTerminalRecord | null;
};

const CLASSIFIER_TABLE: ReadonlyArray<{
  match: (snap: RecoveryJobRow, snapshot: JobStoreSnapshot) => boolean;
  action: (snap: RecoveryJobRow) => RecoveryAction | null;
  description: string;
}> = [
  {
    match: (snap) => snap.status === null && snap.hasLaunch,
    action: (snap) => ({ type: 'deleteIncompleteDir', jobId: snap.jobId }),
    description: 'incomplete admission',
  },
  {
    match: (snap, snapshot) => snap.status !== null && belongsToCurrentNamespace(snap.status, snapshot) && isTerminalPhase(snap.status.phase),
    action: () => null,
    description: 'terminal',
  },
  {
    match: (snap, snapshot) =>
      snap.status !== null &&
      belongsToCurrentNamespace(snap.status, snapshot) &&
      isLivePhase(snap.status.phase) &&
      !snap.hasLaunch,
    action: (snap) =>
      snap.status === null
        ? null
        : {
            type: 'markError',
            jobId: snap.jobId,
            fault: { kind: 'stale_status_schema' },
            status: snap.status,
          },
    description: 'incompatible',
  },
  {
    match: (snap, snapshot) =>
      snap.status !== null &&
      belongsToCurrentNamespace(snap.status, snapshot) &&
      snap.hasLaunch &&
      snap.status.phase === 'queued' &&
      !snap.hasRuntime,
    action: (snap) =>
      snap.launchRecord === null
        ? null
        : {
            type: 'registerQueued',
            jobId: snap.jobId,
            launchRecord: snap.launchRecord,
          },
    description: 'queued',
  },
  {
    match: (snap, snapshot) =>
      snap.status !== null &&
      belongsToCurrentNamespace(snap.status, snapshot) &&
      snap.hasLaunch &&
      !snap.hasRuntime &&
      (snap.status.phase === 'launching' || snap.status.phase === 'running'),
    action: (snap) =>
      snap.status === null
        ? null
        : {
            type: 'markError',
            jobId: snap.jobId,
            fault: { kind: 'ghost_launch' },
            status: snap.status,
          },
    description: 'stale_running',
  },
  {
    match: (snap, snapshot) =>
      snap.status !== null &&
      belongsToCurrentNamespace(snap.status, snapshot) &&
      snap.hasLaunch &&
      snap.hasRuntime &&
      !snap.hasExit &&
      (snap.status.phase === 'launching' || snap.status.phase === 'running'),
    action: (snap) =>
      snap.launchRecord === null || snap.runtimeRecord === null
        ? null
        : {
            type: 'registerRunning',
            jobId: snap.jobId,
            launchRecord: snap.launchRecord,
            runtimeRecord: snap.runtimeRecord,
          },
    description: 'running',
  },
  {
    match: (snap, snapshot) =>
      snap.status !== null &&
      belongsToCurrentNamespace(snap.status, snapshot) &&
      snap.hasLaunch &&
      snap.hasRuntime &&
      snap.hasExit &&
      (snap.status.phase === 'launching' || snap.status.phase === 'running'),
    action: (snap) =>
      snap.launchRecord === null || snap.runtimeRecord === null
        ? null
        : {
            type: 'registerRunning',
            jobId: snap.jobId,
            launchRecord: snap.launchRecord,
            runtimeRecord: snap.runtimeRecord,
          },
    description: 'stale_dead',
  },
  {
    match: () => true,
    action: () => null,
    description: 'null',
  },
];

export function planRecovery(snapshot: JobStoreSnapshot): RecoveryPlan {
  try {
    const jobIds = readJobIds(snapshot);
    const registerRunning: RegisterAction[] = [];
    const registerQueued: Array<Extract<RecoveryAction, { type: 'registerQueued' }>> = [];
    const deleteIncomplete: CleanupAction[] = [];
    const markIncompatible: CleanupAction[] = [];
    const markStaleRunning: CleanupAction[] = [];

    for (const jobId of jobIds) {
      const row = buildJobRow(snapshot, jobId);
      const classified = classifyJobRow(row, snapshot);
      if (classified.action === null) continue;

      switch (classified.description) {
        case 'running':
        case 'stale_dead':
          registerRunning.push(classified.action as RegisterAction);
          break;
        case 'queued':
          registerQueued.push(classified.action as Extract<RecoveryAction, { type: 'registerQueued' }>);
          break;
        case 'incomplete admission':
          deleteIncomplete.push(classified.action as CleanupAction);
          break;
        case 'incompatible':
          markIncompatible.push(classified.action as CleanupAction);
          break;
        case 'stale_running':
          markStaleRunning.push(classified.action as CleanupAction);
          break;
        default:
          break;
      }
    }

    registerQueued.sort((left, right) => left.launchRecord.enqueueSequence - right.launchRecord.enqueueSequence);

    return {
      register: [...registerRunning, ...registerQueued],
      cleanup: [...deleteIncomplete, ...markIncompatible, ...markStaleRunning, ...planSessionClaimReleases(snapshot, jobIds)],
    };
  } catch {
    return { register: [], cleanup: [] };
  }
}

function belongsToCurrentNamespace(status: JobStatusRecord, snapshot: JobStoreSnapshot): boolean {
  return belongsToNamespace(status, snapshot.currentNamespace);
}

function classifyJobRow(
  row: RecoveryJobRow,
  snapshot: JobStoreSnapshot,
): { description: string; action: RecoveryAction | null } {
  for (const classifier of CLASSIFIER_TABLE) {
    const matches = safeCall(() => classifier.match(row, snapshot), false);
    if (!matches) continue;
    return {
      description: classifier.description,
      action: safeCall(() => classifier.action(row), null),
    };
  }

  return { description: 'null', action: null };
}

function buildJobRow(snapshot: JobStoreSnapshot, jobId: string): RecoveryJobRow {
  return {
    jobId,
    hasLaunch: safeCall(() => snapshot.hasLaunch(jobId), false),
    hasRuntime: safeCall(() => snapshot.hasRuntime(jobId), false),
    hasExit: safeCall(() => snapshot.hasExit(jobId), false),
    status: safeCall(() => snapshot.readStatus(jobId), null),
    launchRecord: safeCall(() => snapshot.readLaunch(jobId), null),
    runtimeRecord: safeCall(() => snapshot.readRuntime(jobId), null),
    exitRecord: safeCall(() => snapshot.readExit(jobId), null),
    terminalPayload: safeCall(() => snapshot.readTerminalPayload(jobId), null),
  };
}

function planSessionClaimReleases(snapshot: JobStoreSnapshot, jobIds: readonly string[]): CleanupAction[] {
  const knownJobIds = new Set(jobIds);
  const actions: CleanupAction[] = [];

  for (const ref of readSessionRefs(snapshot)) {
    const session = safeCall(() => snapshot.readSession(ref.shardDir, ref.provider, ref.sessionId), null);
    const activeJobId = session?.activeJobId;
    if (!activeJobId) continue;

    if (!knownJobIds.has(activeJobId)) {
      actions.push({
        type: 'releaseSessionClaim',
        shardDir: ref.shardDir,
        sessionId: ref.sessionId,
        jobId: activeJobId,
      });
      continue;
    }

    const status = safeCall(() => snapshot.readStatus(activeJobId), null);
    if (status !== null && isTerminalPhase(status.phase)) {
      actions.push({
        type: 'releaseSessionClaim',
        shardDir: ref.shardDir,
        sessionId: ref.sessionId,
        jobId: activeJobId,
      });
    }
  }

  return actions;
}

function readJobIds(snapshot: JobStoreSnapshot): string[] {
  const jobIds = safeCall(() => snapshot.jobIds, []);
  if (!Array.isArray(jobIds)) return [];
  return jobIds.filter((jobId): jobId is string => typeof jobId === 'string');
}

function readSessionRefs(snapshot: JobStoreSnapshot): Array<{ shardDir: string; sessionId: string; provider: string }> {
  const refs = safeCall(() => snapshot.listSessionRefs(), []);
  if (!Array.isArray(refs)) return [];

  return refs.filter(
    (ref): ref is { shardDir: string; sessionId: string; provider: string } =>
      ref !== null &&
      typeof ref === 'object' &&
      typeof ref.shardDir === 'string' &&
      typeof ref.sessionId === 'string' &&
      typeof ref.provider === 'string',
  );
}

function safeCall<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch {
    return fallback;
  }
}
