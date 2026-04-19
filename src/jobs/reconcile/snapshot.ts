import { formatError } from '../../shared/utils.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunchRecord, JobRuntimeRecord, JobStatusRecord, JobTerminalRecord } from '../records.js';
import type { JobExitRecord } from '../../runtime/durable-runtime.js';
import type { SessionEntry } from '../../sessions/entry.js';
import type { ProgressStore } from '../job-store.js';
import { readSessionRefs, listSessionShards } from '../../sessions/shell/resolve.js';
import { SessionManager } from '../../sessions/shell/store.js';
import type { JobProjectionDetail } from '../../store/queries/jobs.js';
import type { JobStoreSnapshot } from './plan.js';
import type { Runtime } from '../../runtime/ports.js';
import { withBackendNamespace } from './job-helpers.js';
import { noopAppendEvents } from '../../store/append.js';

function toExitRecord(detail: JobProjectionDetail): JobExitRecord | null {
  if (!detail.exit) {
    return null;
  }

  return {
    exitCode: detail.exit.exitCode ?? null,
    signal: detail.exit.signal ?? null,
    endTime: detail.exit.endTime,
  };
}

function toTerminalPayload(detail: JobProjectionDetail): JobTerminalRecord | null {
  const exit = detail.exit;
  if (!exit) {
    return null;
  }

  return {
    content: exit.content,
    outcome: exit.outcome,
    ...(exit.durationMs === undefined ? {} : { durationMs: exit.durationMs }),
    ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
    ...(exit.nonResumable === undefined ? {} : { nonResumable: exit.nonResumable }),
    ...(exit.warnings === undefined ? {} : { warnings: [...exit.warnings] }),
    ...(exit.usage === undefined ? {} : { usage: { ...exit.usage } }),
    ...(exit.workflow === undefined
      ? {}
      : {
          workflow: {
            steps: exit.workflow.steps.map((step) => ({ ...step })),
          },
        }),
  };
}

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
    const detail = progressStore.loadJobProjectionDetail(jobId);
    let status = detail.status;
    if (
      status
      && isLivePhase(status.phase)
      && (typeof status.backendNamespace !== 'string' || status.backendNamespace.length === 0)
    ) {
      status = withBackendNamespace(status, namespace);
      progressStore.writeStatus(jobId, status);
    }

    hasLaunchByJob.set(jobId, detail.launch !== null);
    hasRuntimeByJob.set(jobId, detail.runtime !== null);
    hasExitByJob.set(jobId, detail.exit !== null);
    statusesByJob.set(jobId, status);
    launchesByJob.set(jobId, detail.launch as JobLaunchRecord | null);
    runtimesByJob.set(jobId, detail.runtime as JobRuntimeRecord | null);
    exitsByJob.set(jobId, toExitRecord(detail));
    terminalPayloadsByJob.set(jobId, toTerminalPayload(detail));
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
