import { formatError } from '../../infra/error-format.js';
import type { TerminalOutcome } from '../outcome.js';
import type { JobStore } from '../store.js';
import { appendJobTerminalRecorded } from '../terminal/recording.js';
import { elapsedDurationMs } from '../duration.js';
import { isLivePhase } from '../phase.js';
import { readProjectionJobRows } from '../projection-row.js';
import { decodeStoredBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';

/**
 * Finalize foreign-namespace live jobs by scanning projections plus the origin
 * `job.launch.requested` envelope namespace in SQLite.
 *
 * Recovery no longer rebinds status files or coordinates through claim files.
 * If a job is still projected as `queued`, `launching`, or `running` but its
 * launch event belongs to a different namespace than the current coordinator,
 * we append a terminal `wrapper_lost` event and let the reducer close the job
 * in the same journal transaction.
 */
export function adoptOrphanedCrossNamespaceJobs(
  currentNamespace: string,
  progressStore: Pick<JobStore, 'commit' | 'getDb' | 'loadJobProjectionDetail'> & StoreReadContext,
  endTimeMs: number,
  log: (message: string) => void,
): number {
  const db = progressStore.getDb();
  const originNamespace = db.prepare<[string], EventsRow>(
    `SELECT *
       FROM events
      WHERE stream_id = ? AND type = 'job.launch.requested'
      ORDER BY seq ASC LIMIT 1`,
  );
  const rows = readProjectionJobRows(db).flatMap((row) => {
    if (!isLivePhase(row.phase)) return [];
    const originEvent = originNamespace.get(row.job_id);
    if (originEvent !== undefined) decodeStoredBody(originEvent, progressStore);
    const origin = originEvent?.namespace;
    if (origin === null || origin === undefined || origin === currentNamespace) return [];
    return [{ job_id: row.job_id, origin_namespace: origin }];
  });

  let adopted = 0;
  for (const row of rows) {
    try {
      const detail = progressStore.loadJobProjectionDetail(row.job_id);
      const status = detail.status;
      const launch = detail.launch;
      if (!status || !launch) {
        continue;
      }

      const outcome = {
        kind: 'job_fault',
        fault: { kind: 'wrapper_lost' },
      } satisfies TerminalOutcome;
      progressStore.commit((c) => {
        appendJobTerminalRecorded(c, {
          jobId: row.job_id,
          sessionId: launch.sessionId,
          namespace: status.backendNamespace,
          project: status.projectRoot,
          terminal: {
            outcome,
            durationMs: elapsedDurationMs(launch.createdAt, endTimeMs, `job ${row.job_id}`),
            content: '',
          },
        });
        return undefined;
      });
      adopted += 1;
      log(`Finalized foreign-namespace job ${row.job_id} from ${row.origin_namespace}\n`);
    } catch (error: unknown) {
      log(`Failed to finalize foreign-namespace job ${row.job_id}: ${formatError(error)}\n`);
    }
  }

  return adopted;
}
