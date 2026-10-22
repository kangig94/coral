import { jobExecutionOutcomeAcceptedBodySchema } from './terminal/result.js';
import type { ExecutionAddress } from './execution-address.js';
import type { EventsRow } from '../store/schema.js';
import type { Database } from '../store/db.js';
import { decodeBody, decodeEventBody, type StoreReadContext } from '../store/body-codec.js';
import {
  jobExecutionRequestedBodySchema,
  jobOpenedBodySchema,
  type JobExecutionRequestedBody,
  type JobOpenedBody,
  type AcceptedProviderJobLaunchDecision,
} from './launch.js';

export interface CommittedExecutionRequest {
  readonly jobId: string;
  readonly requestedSeq: number;
  readonly request: JobExecutionRequestedBody;
}

export function readJobOpened(db: Database, jobId: string, ctx: StoreReadContext): JobOpenedBody | null {
  const row = readJobOpenedEvent(db, jobId);
  return row === undefined ? null : decodeBody(row, jobOpenedBodySchema, ctx);
}

export function findCommittedExecutionRequest(
  db: Database,
  jobId: string,
  clientMessageId: string,
  ctx?: StoreReadContext,
): CommittedExecutionRequest | null {
  const rows = db
    .prepare<
      [string],
      { seq: number; type: string; stream_kind: 'job'; body: Uint8Array }
    >("SELECT seq, type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' ORDER BY seq")
    .all(jobId);
  for (const row of rows) {
    const request =
      ctx === undefined
        ? jobExecutionRequestedBodySchema.parse(decodeEventBody(row.body))
        : decodeBody(row, jobExecutionRequestedBodySchema, ctx);
    if (request.originatingClientMessageId === clientMessageId) return { jobId, requestedSeq: row.seq, request };
  }
  return null;
}

export function committedExecutionRequest(db: Database, jobId: string, execution: number): { requestedSeq: number } {
  const requested = db
    .prepare<
      [string, number],
      { seq: number }
    >("SELECT seq FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
    .get(jobId, execution);
  if (requested === undefined) throw new Error(`Committed execution request is missing: ${jobId}#${execution}`);
  return { requestedSeq: requested.seq };
}

export function readJobOpenedEvent(db: Database, jobId: string): EventsRow | undefined {
  return db
    .prepare<
      [string],
      EventsRow
    >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.opened' ORDER BY seq LIMIT 1")
    .get(jobId);
}

export function readExecutionLifecycleEvents(db: Database, jobId: string): EventsRow[] {
  return db
    .prepare<[string], EventsRow>(
      `SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ?
    AND type IN ('job.execution.requested', 'job.execution.outcome.accepted', 'job.execution.ended',
      'job.retention.discard.requested', 'job.retention.discard.completed', 'job.retention.discard.failed') ORDER BY seq`,
    )
    .all(jobId);
}

export function readExecutionRequestAt(
  db: Database,
  jobId: string,
  requestedSeq: number,
  ctx: StoreReadContext,
): CommittedExecutionRequest | null {
  const row = db
    .prepare<
      [string, number],
      EventsRow
    >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' AND seq = ?")
    .get(jobId, requestedSeq);
  return row === undefined
    ? null
    : { jobId, requestedSeq: row.seq, request: decodeBody(row, jobExecutionRequestedBodySchema, ctx) };
}

export function readExecutionAcceptedOutcomeEvent(
  db: Database,
  readCtx: StoreReadContext,
  address: ExecutionAddress,
): EventsRow {
  const row = db
    .prepare<[string, number], EventsRow>(
      `SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ?
      AND type = 'job.execution.outcome.accepted'
      AND json_extract(CAST(body AS TEXT), '$.execution') = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(address.jobId, address.execution);
  if (row === undefined)
    throw new Error(`Job ${address.jobId} execution #${address.execution} has no accepted outcome.`);
  decodeBody(row, jobExecutionOutcomeAcceptedBodySchema, readCtx);
  return row;
}

export function committedProviderLaunchDecision(
  db: Database,
  committed: CommittedExecutionRequest,
  epochKey: string,
): AcceptedProviderJobLaunchDecision {
  const admission = db
    .prepare<
      [string, number],
      { type: string }
    >("SELECT type FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type IN ('job.execution.queued', 'job.execution.admitted') AND json_extract(CAST(body AS TEXT), '$.execution') = ? ORDER BY seq LIMIT 1")
    .get(committed.jobId, committed.request.execution);
  if (admission === undefined)
    throw new Error(`Committed execution admission is missing: ${committed.jobId}#${committed.request.execution}`);
  return {
    kind: 'provider-session',
    status: admission.type === 'job.execution.queued' ? 'queued' : 'running',
    jobId: committed.jobId,
    requestedSeq: committed.requestedSeq,
    epochKey,
  };
}
