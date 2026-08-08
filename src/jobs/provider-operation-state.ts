import type { Database } from '../store/db.js';
import type { JobProgressStore } from './contracts/job-store.js';
import type { ProviderOperationCleanupIdentity } from './contracts/provider-operation-lifecycle.js';
import type { ProviderJobLaunch } from './records.js';

type ProviderOperationJobStore = Pick<JobProgressStore, 'getDb' | 'readLaunchProjection'>;

function requireProviderLaunch(store: ProviderOperationJobStore, jobId: string): ProviderJobLaunch {
  const launch = store.readLaunchProjection(jobId);
  if (launch === null || launch.jobKind !== 'provider') {
    throw new Error(`Provider operation job '${jobId}' has no durable provider launch.`);
  }
  return launch;
}

function assertLaunchEvent(db: Database, jobId: string, eventSeq: number): void {
  const event = db
    .prepare<
      [number],
      { type: string; stream_kind: string; stream_id: string }
    >('SELECT type, stream_kind, stream_id FROM events WHERE seq = ?')
    .get(eventSeq);
  if (event?.type !== 'job.launch.requested' || event.stream_kind !== 'job' || event.stream_id !== jobId) {
    throw new Error(`Provider operation job '${jobId}' launch event ${eventSeq} is unavailable or mismatched.`);
  }
}

export function readProviderOperationJobLaunch(
  store: ProviderOperationJobStore,
  jobId: string,
  expectedEventSeq?: number,
): ProviderJobLaunch {
  if (expectedEventSeq !== undefined) assertLaunchEvent(store.getDb(), jobId, expectedEventSeq);
  return requireProviderLaunch(store, jobId);
}

export function readProviderOperationJobLaunchEventSeq(db: Database, jobId: string): number {
  const event = db
    .prepare<[string], { seq: number }>(
      `SELECT seq FROM events
        WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(jobId);
  if (event === undefined) throw new Error(`Provider operation job '${jobId}' has no durable launch event.`);
  return event.seq;
}

export function providerOperationCleanupIdentity(
  launch: Pick<ProviderJobLaunch, 'jobId' | 'pool'>,
): ProviderOperationCleanupIdentity {
  return { jobId: launch.jobId, pool: launch.pool };
}
