import { formatError } from '../../infra/error-format.js';
import type { SessionEntry } from '../../sessions/entry.js';
import type { ProgressStore } from '../job-store.js';
import type { SessionLookup } from '../../sessions/lookup.js';
import type { RecoveryJobFacts, RecoveryProjectionSnapshot } from './plan.js';

export function buildRecoverySnapshot(
  progressStore: ProgressStore,
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
  const sessionsById = new Map<string, SessionEntry | null>();

  for (const sessionRef of sessionLookup.listSessionRefs()) {
    try {
      sessionRefs.push({ sessionId: sessionRef.sessionId, provider: sessionRef.provider });
      sessionsById.set(sessionRef.sessionId, sessionLookup.readSessionEntry(sessionRef.sessionId));
    } catch (error: unknown) {
      log(`Failed to check session ${sessionRef.sessionId}: ${formatError(error)}\n`);
    }
  }

  const snapshot: RecoveryProjectionSnapshot = {
    jobIds,
    currentNamespace: namespace,
    readJob: (jobId: string): RecoveryJobFacts => factsByJob.get(jobId) ?? {
      jobId,
      hasLaunchRequest: false,
      hasRuntimeStart: false,
      hasTerminalRecord: false,
      status: null,
      launchRecord: null,
      runtimeRecord: null,
    },
    listSessionRefs: (): Array<{ sessionId: string; provider: string }> => [...sessionRefs],
    readSession: (sessionId: string): SessionEntry | null => sessionsById.get(sessionId) ?? null,
  };

  return Object.freeze(snapshot);
}
