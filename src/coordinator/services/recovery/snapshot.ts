import { hydrateJobRecoveryProjection, type JobStore } from '../../../jobs/store.js';
import { type JobConversation } from '../../../jobs/conversation/entry.js';
import type { ProcessPort } from '../../../runtime/ports.js';
import type {
  RecoveryJobFacts,
  RecoveryProjectionSnapshot,
} from '../../../jobs/reconcile/plan.js';
import type { JobProjectionDetail } from '../../../jobs/read-queries.js';
import type { JobStatus } from '../../../jobs/records.js';
import type { RawCoordinatorJobRecoveryEnvelope } from './coordinator-job-source.js';
import { hydrateCoordinatorConversationAuthority } from './authority-snapshot.js';

export type CoordinatorRecoveryItem = Readonly<{
  jobId: string;
  detail: (JobProjectionDetail & Readonly<{ status: JobStatus }>) | null;
  conversation: JobConversation | null;
}>;

export function hydrateCoordinatorRecoveryItem(
  raw: RawCoordinatorJobRecoveryEnvelope,
  progressStore: JobStore,
): CoordinatorRecoveryItem {
  const conversation = raw.conversation === null ? null : hydrateCoordinatorConversationAuthority(raw.conversation);
  if (raw.projection === null) throw new TypeError(`Job '${raw.jobId}' has no recovery projection.`);
  const detail = hydrateJobRecoveryProjection({ projection: raw.projection, events: raw.statusEvents }, progressStore);
  if (detail.status === null) {
    throw new TypeError(`Raw coordinator projection '${raw.projection.job_id}' did not hydrate a job status.`);
  }
  return Object.freeze({
    jobId: raw.jobId,
    detail: { ...detail, status: detail.status },
    conversation,
  });
}

export function buildRecoverySnapshot(
  items: readonly CoordinatorRecoveryItem[],
  process: Pick<ProcessPort, 'observeLiveness'>,
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

  const snapshot: RecoveryProjectionSnapshot = {
    jobIds,
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
    // Planning needs a boolean and only one of the three answers may mean "gone": "could not tell" must never
    // read as it, because that is the reading that destroys a live job's record. The per-item paths that follow
    // observe again and handle unknown on their own terms.
    isPidAlive: (pid: number): boolean => process.observeLiveness(pid) !== 'absent',
  };

  return Object.freeze(snapshot);
}
