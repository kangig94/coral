import { formatError } from '../../infra/error-format.js';
import type { ProgressStore } from '../job-store.js';

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
  progressStore: Pick<ProgressStore, 'appendEvent' | 'getDb' | 'loadJobProjectionDetail'>,
  log: (message: string) => void,
): number {
  const db = progressStore.getDb();
  const rows = db
    .prepare(
      `SELECT
         pj.job_id AS job_id,
         origin.namespace AS origin_namespace
       FROM projection_jobs pj
       JOIN events origin
         ON origin.seq = (
           SELECT MIN(seq)
             FROM events
            WHERE stream_kind = 'job'
              AND stream_id = pj.job_id
              AND type = 'job.launch.requested'
         )
      WHERE origin.namespace != ?
        AND pj.phase IN ('queued', 'launching', 'running')
      ORDER BY pj.job_id ASC`,
    )
    .all(currentNamespace) as Array<{
    job_id: string;
    origin_namespace: string;
  }>;

  let adopted = 0;
  for (const row of rows) {
    try {
      const detail = progressStore.loadJobProjectionDetail(row.job_id);
      const status = detail.status;
      const launch = detail.launch;
      if (!status || !launch) {
        continue;
      }

      progressStore.appendEvent({
        type: 'job.terminal.recorded',
        stream: { kind: 'job', id: row.job_id },
        namespace: currentNamespace,
        project: launch.projectRoot,
        refs: {
          jobId: row.job_id,
          sessionId: launch.sessionId,
          ...(launch.parentWorkflowJobId ? { parentJobId: launch.parentWorkflowJobId } : {}),
          ...(launch.workflowSlotId ? { workflowSlotId: launch.workflowSlotId } : {}),
        },
        bodyVersion: 1,
        body: {
          outcome: {
            kind: 'job_fault',
            fault: { kind: 'wrapper_lost' },
          },
          durationMs: 0,
          content: '',
        },
      });
      adopted += 1;
      log(`Finalized foreign-namespace job ${row.job_id} from ${row.origin_namespace}\n`);
    } catch (error: unknown) {
      log(`Failed to finalize foreign-namespace job ${row.job_id}: ${formatError(error)}\n`);
    }
  }

  return adopted;
}
