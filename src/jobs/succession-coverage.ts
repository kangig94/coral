import { sameEpoch } from '../store/epoch/identity.js';
import type { Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import type { CustodyEntry } from '../store/custody-ledger.js';
import { jobLaunchRequestBodySchema } from './launch.js';

export function readSuccessionLiveJobIds(
  db: Database,
  pendingLaunchIds: readonly string[],
  carrierIds: readonly string[],
  custodyJobIds: readonly string[],
): readonly string[] {
  const rows = db
    .prepare<
      [],
      { job_id: string }
    >("SELECT job_id FROM projection_jobs WHERE phase NOT IN ('completed', 'error', 'aborted')")
    .all();
  return [...new Set([...rows.map((row) => row.job_id), ...pendingLaunchIds, ...carrierIds, ...custodyJobIds])];
}

/** An unreadable entry may name an unbound external effect, so it must not certify coverage. */
export function readSuccessionCustodyJobIds(
  entries: readonly CustodyEntry[],
  epoch: Readonly<{ epochPath: string; lineageKey: string | null }>,
): readonly string[] {
  return entries.flatMap((entry) => {
    if (entry.kind === 'unreadable') throw new Error(`Custody entry is unreadable: ${entry.path}`);
    if (entry.kind !== 'holding') return [];
    const intent = entry.intent;
    const inEpoch =
      intent.epochKey === undefined ? intent.epoch === epoch.epochPath : sameEpoch(intent.epochKey, epoch.lineageKey);
    const jobId = intent.jobId ?? (intent.owner === 'durable-cli' ? intent.operationId : undefined);
    return inEpoch && jobId !== undefined ? [jobId] : [];
  });
}

export function readSuccessionJobIdsByKind(db: Database, jobKind: 'workflow' | 'kb'): readonly string[] {
  return db
    .prepare<[string], { job_id: string }>(
      "SELECT job_id FROM projection_jobs WHERE job_kind = ? AND phase NOT IN ('completed', 'error', 'aborted')",
    )
    .all(jobKind)
    .map((row) => row.job_id);
}

export function readJobLaunchOriginNamespace(
  db: Database,
  jobId: string,
  readContext: StoreReadContext,
): string | null {
  const rows = db
    .prepare<
      [string],
      { body: Uint8Array }
    >("SELECT body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested'")
    .all(jobId);
  if (rows.length !== 1) return null;
  try {
    const launch = decodeBody(
      { type: 'job.launch.requested', stream_kind: 'job', body: rows[0].body },
      jobLaunchRequestBodySchema,
      readContext,
    );
    return launch.backendNamespace;
  } catch {
    return null;
  }
}
