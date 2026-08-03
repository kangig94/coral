import { hydrateJobRecoveryProjection, type JobStore } from '../../../jobs/store.js';
import { providerSessionProvider, type ProviderSession } from '../../../sessions/entry.js';
import type { ProcessPort } from '../../../runtime/ports.js';
import type {
  RecoveryJobFacts,
  RecoveryProjectionSnapshot,
  RecoverySessionFacts,
} from '../../../jobs/reconcile/plan.js';
import type { JobProjectionDetail } from '../../../jobs/read-queries.js';
import type { JobStatus } from '../../../jobs/records.js';
import type { RawCoordinatorJobRecoveryEnvelope } from './coordinator-job-source.js';
import { hydrateCoordinatorSessionAuthority } from './authority-snapshot.js';

export type CoordinatorRecoveryItem = Readonly<{
  jobId: string;
  detail: (JobProjectionDetail & Readonly<{ status: JobStatus }>) | null;
  claimedSession: ProviderSession | null;
  claimedSessionLastSeq: number | null;
  launchEventNamespace: string | null;
}>;

export function hydrateCoordinatorRecoveryItem(
  raw: RawCoordinatorJobRecoveryEnvelope,
  progressStore: JobStore,
): CoordinatorRecoveryItem {
  const claimedSession = raw.claimedSession === null ? null : hydrateCoordinatorSessionAuthority(raw.claimedSession);
  if (raw.projection === null) {
    if (claimedSession?.activeJobId !== raw.jobId) {
      throw new TypeError(`Raw orphaned claim '${raw.jobId}' does not name its coordinator subject.`);
    }
    return Object.freeze({
      jobId: raw.jobId,
      detail: null,
      claimedSession,
      claimedSessionLastSeq: raw.claimedSession?.last_seq ?? null,
      launchEventNamespace: null,
    });
  }
  const detail = hydrateJobRecoveryProjection({ projection: raw.projection, events: raw.statusEvents }, progressStore);
  if (detail.status === null) {
    throw new TypeError(`Raw coordinator projection '${raw.projection.job_id}' did not hydrate a job status.`);
  }
  return Object.freeze({
    jobId: raw.jobId,
    detail: { ...detail, status: detail.status },
    claimedSession,
    claimedSessionLastSeq: raw.claimedSession?.last_seq ?? null,
    launchEventNamespace:
      [...raw.statusEvents].reverse().find((event) => event.type === 'job.launch.requested')?.namespace ?? null,
  });
}

export function buildRecoverySnapshot(
  items: readonly CoordinatorRecoveryItem[],
  namespace: string,
  process: Pick<ProcessPort, 'isAlive'>,
): RecoveryProjectionSnapshot {
  const jobIds = Object.freeze(items.flatMap(({ detail }) => (detail === null ? [] : [detail.status.jobId])));
  const factsByJob = new Map<string, RecoveryJobFacts>();

  for (const { detail } of items) {
    if (detail === null) continue;
    const jobId = detail.status.jobId;
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

  for (const { claimedSession } of items) {
    if (claimedSession === null || sessionsById.has(claimedSession.sessionId)) continue;
    const sessionFacts: RecoverySessionFacts = claimedSession.activeJobId
      ? { activeJobId: claimedSession.activeJobId }
      : {};
    sessionRefs.push({
      sessionId: claimedSession.sessionId,
      provider: providerSessionProvider(claimedSession),
    });
    sessionsById.set(claimedSession.sessionId, sessionFacts);
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
    isPidAlive: (pid: number): boolean => process.isAlive(pid),
  };

  return Object.freeze(snapshot);
}
