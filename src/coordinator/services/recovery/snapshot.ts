import { formatError } from '../../../infra/error-format.js';
import type { JobStore } from '../../../jobs/job-store.js';
import type { SessionLookup } from '../../../sessions/lookup.js';
import type { RecoveryJobFacts, RecoveryProjectionSnapshot, RecoverySessionFacts } from '../../../jobs/reconcile/plan.js';

export function buildRecoverySnapshot(
  progressStore: JobStore,
  namespace: string,
  log: (message: string) => void,
  sessionLookup: SessionLookup,
): RecoveryProjectionSnapshot {
  const jobIds = Object.freeze([...progressStore.listJobIds()]);
  const factsByJob = new Map<string, RecoveryJobFacts>();

  for (const jobId of jobIds) {
    const detail = progressStore.loadJobProjectionDetail(jobId);
    factsByJob.set(jobId, {
      jobId,
      hasLaunchRequest: detail.launch !== null,
      hasRuntimeStart: detail.runtime !== null,
      hasTerminalRecord: detail.exit !== null,
      status: detail.status,
      launchRecord: detail.launch,
      runtimeRecord: detail.runtime,
    });
  }

  const sessionRefs: Array<{ sessionId: string; provider: string }> = [];
  const sessionsById = new Map<string, RecoverySessionFacts | null>();

  for (const sessionRef of sessionLookup.listSessionRefs()) {
    try {
      const entry = sessionLookup.readSessionEntry(sessionRef.sessionId);
      sessionRefs.push({ sessionId: sessionRef.sessionId, provider: sessionRef.provider });
      sessionsById.set(
        sessionRef.sessionId,
        entry ? (entry.activeJobId ? { activeJobId: entry.activeJobId } : {}) : null,
      );
    } catch (error: unknown) {
      log(`Failed to check session ${sessionRef.sessionId}: ${formatError(error)}\n`);
    }
  }

  const snapshot: RecoveryProjectionSnapshot = {
    jobIds,
    currentNamespace: namespace,
    readJob: (jobId: string): RecoveryJobFacts =>
      factsByJob.get(jobId) ?? {
        jobId,
        hasLaunchRequest: false,
        hasRuntimeStart: false,
        hasTerminalRecord: false,
        status: null,
        launchRecord: null,
        runtimeRecord: null,
      },
    listSessionRefs: (): Array<{ sessionId: string; provider: string }> => [...sessionRefs],
    readSession: (sessionId: string): RecoverySessionFacts | null => sessionsById.get(sessionId) ?? null,
  };

  return Object.freeze(snapshot);
}
