import { formatError } from '../../infra/error-format.js';
import { isLivePhase } from '../phase.js';
import type { JobLaunch, JobRuntime, JobStatus, JobTerminal } from '../records.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { SessionEntry } from '../../sessions/entry.js';
import type { ProgressStore } from '../job-store.js';
import type { SessionLookup } from '../../sessions/lookup.js';
import type { JobProjectionDetail } from '../read-contracts.js';
import type { JobStoreSnapshot } from './plan.js';
import { withBackendNamespace } from './recovery-effects.js';

function toExitRecord(detail: JobProjectionDetail): DurableProcessExit | null {
  if (!detail.exit) {
    return null;
  }

  return {
    exitCode: detail.exit.exitCode ?? null,
    signal: detail.exit.signal ?? null,
    endTime: detail.exit.endTime,
  };
}

function toTerminalPayload(detail: JobProjectionDetail): JobTerminal | null {
  const exit = detail.exit;
  if (!exit) {
    return null;
  }

  return {
    content: exit.content,
    outcome: exit.outcome,
    durationMs: exit.durationMs,
  };
}

export function buildRecoverySnapshot(
  progressStore: ProgressStore,
  namespace: string,
  log: (message: string) => void,
  sessionLookup: SessionLookup,
): JobStoreSnapshot {
  const jobIds = Object.freeze([...progressStore.listJobIds()]);
  const hasLaunchByJob = new Map<string, boolean>();
  const hasRuntimeByJob = new Map<string, boolean>();
  const hasExitByJob = new Map<string, boolean>();
  const statusesByJob = new Map<string, JobStatus | null>();
  const launchesByJob = new Map<string, JobLaunch | null>();
  const runtimesByJob = new Map<string, JobRuntime | null>();
  const exitsByJob = new Map<string, DurableProcessExit | null>();
  const terminalPayloadsByJob = new Map<string, JobTerminal | null>();

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
    launchesByJob.set(jobId, detail.launch);
    runtimesByJob.set(jobId, detail.runtime);
    exitsByJob.set(jobId, toExitRecord(detail));
    terminalPayloadsByJob.set(jobId, toTerminalPayload(detail));
  }

  const sessionRefs: Array<{ sessionId: string; provider: string }> = [];
  const sessionsById = new Map<string, SessionEntry | null>();

  for (const sessionRef of sessionLookup.listSessionRefs()) {
    try {
      sessionRefs.push({ sessionId: sessionRef.sessionId, provider: sessionRef.provider });
      sessionsById.set(sessionRef.sessionId, sessionLookup.readSessionEntry(sessionRef.sessionId));
    } catch (error: unknown) {
      log(`Failed to check session ${sessionRef.sessionId}: ${formatError(error)}\n`);
    }
  }

  const snapshot: JobStoreSnapshot = {
    jobIds,
    currentNamespace: namespace,
    hasLaunch: (jobId: string): boolean => hasLaunchByJob.get(jobId) === true,
    hasRuntime: (jobId: string): boolean => hasRuntimeByJob.get(jobId) === true,
    hasExit: (jobId: string): boolean => hasExitByJob.get(jobId) === true,
    readStatus: (jobId: string): JobStatus | null => statusesByJob.get(jobId) ?? null,
    readLaunch: (jobId: string): JobLaunch | null => launchesByJob.get(jobId) ?? null,
    readRuntime: (jobId: string): JobRuntime | null => runtimesByJob.get(jobId) ?? null,
    readExit: (jobId: string): DurableProcessExit | null => exitsByJob.get(jobId) ?? null,
    readTerminalPayload: (jobId: string): JobTerminal | null => terminalPayloadsByJob.get(jobId) ?? null,
    listSessionRefs: (): Array<{ sessionId: string; provider: string }> => [...sessionRefs],
    readSession: (sessionId: string): SessionEntry | null => sessionsById.get(sessionId) ?? null,
  };

  return Object.freeze(snapshot);
}
