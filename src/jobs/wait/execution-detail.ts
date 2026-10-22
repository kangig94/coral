import { executionOrdinalSchema } from '../launch.js';
import { WaitSessionError } from './session.js';
import type { Database } from '../../store/db.js';
import type { StoreReadContext } from '../../store/body-codec.js';
import { loadJobExecutionDetails, loadJobWaitDetail, type JobWaitDetail } from '../read-queries.js';

export type ExecutionWaitDetail = JobWaitDetail & {
  requestedSeq?: number;
  terminalSeq?: number;
  requestSeqs?: number[];
};

export function loadExecutionWaitDetail(
  db: Database,
  jobId: string,
  ctx: StoreReadContext,
  requestedSeq?: number,
  jobIds: readonly string[] = [jobId],
): ExecutionWaitDetail {
  db.exec('SAVEPOINT wait_execution_read');
  try {
    const requests = db
      .prepare<
        [string],
        { seq: number; execution: number }
      >("SELECT seq, json_extract(CAST(body AS TEXT), '$.execution') AS execution FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' ORDER BY seq")
      .all(jobId);
    for (const [index, request] of requests.entries())
      if (!executionOrdinalSchema.safeParse(request.execution).success || request.execution !== index + 1)
        throw new WaitSessionError(
          'wait_selection_invalid',
          'Execution request history cannot validate this admission.',
          jobIds,
        );
    const selected = requestedSeq ?? requests.at(-1)?.seq;
    const ordinal = requests.findIndex((request) => request.seq === selected) + 1;
    if (ordinal === 0)
      return { status: null, runtime: null, exit: null, requestSeqs: requests.map((request) => request.seq) };
    const terminalSeq = db
      .prepare<
        [string, number],
        { seq: number }
      >("SELECT seq FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.ended' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
      .get(jobId, ordinal)?.seq;
    const boundaries = { requestedSeq: selected, terminalSeq, requestSeqs: requests.map((request) => request.seq) };
    if (ordinal === requests.length) {
      const detail = loadJobWaitDetail(db, jobId, ctx);
      if (detail.status?.execution !== ordinal)
        throw new WaitSessionError(
          'wait_selection_invalid',
          'The projection does not match the selected request.',
          jobIds,
        );
      return { ...detail, ...boundaries };
    }
    const execution = loadJobExecutionDetails(db, jobId, ctx).find((entry) => entry.requestedSeq === selected);
    if (execution === undefined) return { status: null, runtime: null, exit: null, ...boundaries };
    return {
      status: execution.detail.status,
      runtime: execution.runtime,
      exit: execution.detail.exit,
      finishing: false,
      ...boundaries,
    };
  } catch (error) {
    db.exec('ROLLBACK TO wait_execution_read');
    throw error;
  } finally {
    db.exec('RELEASE wait_execution_read');
  }
}
