import type { Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import {
  jobExecutionRequestedBodySchema,
  jobOpenedBodySchema,
  type JobExecutionRequestedBody,
  type JobOpenedBody,
} from './launch.js';

export interface CommittedExecutionRequest {
  readonly jobId: string;
  readonly requestedSeq: number;
  readonly request: JobExecutionRequestedBody;
}

export function readJobOpened(db: Database, jobId: string, ctx: StoreReadContext): JobOpenedBody | null {
  const row = db
    .prepare<
      [string],
      { type: string; stream_kind: 'job'; body: Uint8Array }
    >("SELECT type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.opened' ORDER BY seq LIMIT 1")
    .get(jobId);
  return row === undefined ? null : decodeBody(row, jobOpenedBodySchema, ctx);
}

export function readLatestExecutionRequest(
  db: Database,
  jobId: string,
  ctx: StoreReadContext,
): CommittedExecutionRequest | null {
  const row = db
    .prepare<
      [string],
      { seq: number; type: string; stream_kind: 'job'; body: Uint8Array }
    >("SELECT seq, type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' ORDER BY seq DESC LIMIT 1")
    .get(jobId);
  return row === undefined
    ? null
    : { jobId, requestedSeq: row.seq, request: decodeBody(row, jobExecutionRequestedBodySchema, ctx) };
}

export function findCommittedExecutionRequest(
  db: Database,
  jobId: string,
  clientMessageId: string,
  ctx: StoreReadContext,
): CommittedExecutionRequest | null {
  const rows = db
    .prepare<
      [string],
      { seq: number; type: string; stream_kind: 'job'; body: Uint8Array }
    >("SELECT seq, type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' ORDER BY seq")
    .all(jobId);
  for (const row of rows) {
    const request = decodeBody(row, jobExecutionRequestedBodySchema, ctx);
    if (request.originatingClientMessageId === clientMessageId) return { jobId, requestedSeq: row.seq, request };
  }
  return null;
}
