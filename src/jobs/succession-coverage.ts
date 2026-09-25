import type { Database } from '../store/db.js';
import { decodeBody } from '../store/body-codec.js';
import { createDefaultStoreReadContext } from '../read-model/read-context.js';
import { jobLaunchRequestBodySchema } from './launch.js';

export function readSuccessionLiveJobIds(
  db: Database,
  pendingLaunchIds: readonly string[],
  carrierIds: readonly string[],
): readonly string[] {
  const rows = db
    .prepare<[], { job_id: string }>(
      "SELECT job_id FROM projection_jobs WHERE phase NOT IN ('completed', 'error', 'aborted')",
    )
    .all();
  return [...new Set([...rows.map((row) => row.job_id), ...pendingLaunchIds, ...carrierIds])];
}

export function readSuccessionJobIdsByKind(db: Database, jobKind: 'workflow' | 'kb'): readonly string[] {
  return db
    .prepare<[string], { job_id: string }>(
      "SELECT job_id FROM projection_jobs WHERE job_kind = ? AND phase NOT IN ('completed', 'error', 'aborted')",
    )
    .all(jobKind)
    .map((row) => row.job_id);
}

export function certifySuccessionJobCoverage(
  liveJobIds: readonly string[],
  claims: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const failures: string[] = [];
  for (const jobId of new Set([...liveJobIds, ...claims.keys()])) {
    const owners = claims.get(jobId) ?? [];
    if (owners.length === 0) failures.push(`unclaimed: ${jobId}`);
    else if (owners.length !== 1) failures.push(`multiply claimed: ${jobId}`);
  }
  return failures;
}

export function readJobLaunchOriginNamespace(db: Database, jobId: string): string | null {
  const rows = db
    .prepare<[string], { body: Uint8Array }>(
      "SELECT body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'",
    )
    .all(jobId);
  if (rows.length !== 1) return null;
  try {
    const launch = decodeBody(
      { type: 'job.launch.requested', stream_kind: 'job', body: rows[0]!.body },
      jobLaunchRequestBodySchema,
      createDefaultStoreReadContext(),
    );
    return launch.backendNamespace;
  } catch {
    return null;
  }
}
