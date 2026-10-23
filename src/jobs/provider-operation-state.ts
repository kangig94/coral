import { jobExecutionRequestedBodySchema } from './launch.js';
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

function assertLaunchEvent(db: Database, jobId: string, eventSeq: number): number {
  const event = db
    .prepare<
      [number],
      { type: string; stream_kind: string; stream_id: string; body: Uint8Array }
    >('SELECT type, stream_kind, stream_id, body FROM events WHERE seq = ?')
    .get(eventSeq);
  if (event?.type !== 'job.execution.requested' || event.stream_kind !== 'job' || event.stream_id !== jobId) {
    throw new Error(`Provider operation job '${jobId}' launch event ${eventSeq} is unavailable or mismatched.`);
  }
  return jobExecutionRequestedBodySchema.parse(JSON.parse(Buffer.from(event.body).toString('utf8'))).execution;
}

export function readProviderOperationJobLaunch(
  store: ProviderOperationJobStore,
  jobId: string,
  expectedEventSeq?: number,
): ProviderJobLaunch {
  const launch = requireProviderLaunch(store, jobId);
  if (expectedEventSeq !== undefined && assertLaunchEvent(store.getDb(), jobId, expectedEventSeq) !== launch.execution)
    throw new Error(`Provider operation job '${jobId}' no longer owns the selected execution.`);
  return launch;
}

export function readProviderOperationJobLaunchEventSeq(db: Database, jobId: string): number {
  const event = db
    .prepare<[string], { seq: number }>(
      `SELECT seq FROM events
        WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(jobId);
  if (event === undefined) throw new Error(`Provider operation job '${jobId}' has no durable launch event.`);
  return event.seq;
}

export function providerOperationCleanupIdentity(
  launch: Pick<ProviderJobLaunch, 'jobId' | 'pool' | 'execution'>,
): ProviderOperationCleanupIdentity {
  return { kind: 'job-local', jobId: launch.jobId, execution: launch.execution, pool: launch.pool };
}
