import { formatError } from '../../shared/utils.js';
import {
  isLivePhase,
  readBackendNamespace,
  type JobExitRecord,
  type JobLaunchRecord,
  type JobRuntimeRecord,
  type JobStatusRecord,
  type SessionEntry,
  type JobTerminalRecord,
} from '../../shared/types.js';
import type { ProgressStore } from '../../execution/progress-store.js';
import { readSessionRefs, listSessionShards } from '../../sessions/shell/resolve.js';
import { SessionManager } from '../../sessions/shell/store.js';
import type { JobStoreSnapshot } from './plan.js';
import type { Runtime } from '../../runtime/ports.js';
import { withBackendNamespace } from './job-helpers.js';
import { noopAppendEvents } from '../../store/append.js';

export function buildRecoverySnapshot(
  progressStore: ProgressStore,
  namespace: string,
  runtime: Runtime,
  log: (message: string) => void,
): JobStoreSnapshot {
  const jobIds = Object.freeze([...progressStore.listJobIds()]);
  const hasLaunchByJob = new Map<string, boolean>();
  const hasRuntimeByJob = new Map<string, boolean>();
  const hasExitByJob = new Map<string, boolean>();
  const statusesByJob = new Map<string, JobStatusRecord | null>();
  const launchesByJob = new Map<string, JobLaunchRecord | null>();
  const runtimesByJob = new Map<string, JobRuntimeRecord | null>();
  const exitsByJob = new Map<string, JobExitRecord | null>();
  const terminalPayloadsByJob = new Map<string, JobTerminalRecord | null>();

  for (const jobId of jobIds) {
    let status = progressStore.readStatus(jobId);
    if (status && isLivePhase(status.phase) && readBackendNamespace(status) === null) {
      status = withBackendNamespace(status, namespace);
      progressStore.writeStatus(jobId, status);
    }

    hasLaunchByJob.set(jobId, progressStore.hasLaunchRecord(jobId));
    hasRuntimeByJob.set(jobId, progressStore.hasRuntimeRecord(jobId));
    hasExitByJob.set(jobId, progressStore.hasExitRecord(jobId));
    statusesByJob.set(jobId, status);
    launchesByJob.set(jobId, progressStore.readLaunchRecord(jobId));
    runtimesByJob.set(jobId, progressStore.readRuntimeRecord(jobId));
    exitsByJob.set(jobId, progressStore.readExitRecord(jobId));
    terminalPayloadsByJob.set(jobId, progressStore.readTerminalPayload(jobId));
  }

  const sessionRefs: Array<{ shardDir: string; sessionId: string; provider: string }> = [];
  const sessionsByRef = new Map<string, SessionEntry | null>();
  const sessionKey = (shardDir: string, provider: string, sessionId: string): string =>
    `${shardDir}\u0000${provider}\u0000${sessionId}`;

  for (const shardDir of listSessionShards(runtime)) {
    try {
      const sessionManager = SessionManager.openShard(shardDir, runtime, noopAppendEvents);
      for (const sessionRef of readSessionRefs(shardDir, runtime.storage)) {
        try {
          sessionRefs.push({ shardDir, ...sessionRef });
          sessionsByRef.set(
            sessionKey(shardDir, sessionRef.provider, sessionRef.sessionId),
            sessionManager.get(sessionRef.provider, sessionRef.sessionId),
          );
        } catch (error: unknown) {
          log(`Failed to check session ${sessionRef.sessionId}: ${formatError(error)}\n`);
        }
      }
    } catch (error: unknown) {
      log(`Failed to scan session shard ${shardDir}: ${formatError(error)}\n`);
    }
  }

  const snapshot: JobStoreSnapshot = {
    jobIds,
    currentNamespace: namespace,
    hasLaunch: (jobId: string): boolean => hasLaunchByJob.get(jobId) === true,
    hasRuntime: (jobId: string): boolean => hasRuntimeByJob.get(jobId) === true,
    hasExit: (jobId: string): boolean => hasExitByJob.get(jobId) === true,
    readStatus: (jobId: string): JobStatusRecord | null => statusesByJob.get(jobId) ?? null,
    readLaunch: (jobId: string): JobLaunchRecord | null => launchesByJob.get(jobId) ?? null,
    readRuntime: (jobId: string): JobRuntimeRecord | null => runtimesByJob.get(jobId) ?? null,
    readExit: (jobId: string): JobExitRecord | null => exitsByJob.get(jobId) ?? null,
    readTerminalPayload: (jobId: string): JobTerminalRecord | null => terminalPayloadsByJob.get(jobId) ?? null,
    listSessionRefs: (): Array<{ shardDir: string; sessionId: string; provider: string }> => [...sessionRefs],
    readSession: (shardDir: string, provider: string, sessionId: string): SessionEntry | null =>
      sessionsByRef.get(sessionKey(shardDir, provider, sessionId)) ?? null,
  };

  return Object.freeze(snapshot);
}
