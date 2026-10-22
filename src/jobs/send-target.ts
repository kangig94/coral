import { z } from 'zod';
import { sameEpoch } from '../store/epoch/identity.js';
import { committedExecutionRequest, type CommittedExecutionRequest } from './execution-journal.js';
import type { Database } from '../store/db.js';

export const jobSendTargetSchema = z
  .object({
    mode: z.enum(['steer', 'continue']),
    execution: z.number().int().positive().safe(),
    requestedSeq: z.number().int().positive().safe(),
    sourceEpoch: z.string().min(1),
  })
  .strict();

export type JobSendTarget = Readonly<z.infer<typeof jobSendTargetSchema>>;

export function matchesContinuationEnvelope(
  db: Database,
  attempt: Readonly<{ target: JobSendTarget; input: string }>,
  replay: CommittedExecutionRequest,
  sourceEpoch: string,
): boolean {
  return (
    replay.request.execution === attempt.target.execution + 1 &&
    replay.request.input === attempt.input &&
    matchesContinuationTarget(attempt.target, {
      execution: replay.request.execution - 1,
      open: false,
      requestedSeq: committedExecutionRequest(db, replay.jobId, attempt.target.execution).requestedSeq,
      sourceEpoch,
    })
  );
}

export function matchesContinuationTarget(
  target: JobSendTarget,
  predecessor: Readonly<{ execution: number | null; open: boolean; requestedSeq: number | null; sourceEpoch: string }>,
): boolean {
  return (
    target.mode === 'continue' &&
    !predecessor.open &&
    predecessor.execution === target.execution &&
    predecessor.requestedSeq === target.requestedSeq &&
    sameEpoch(predecessor.sourceEpoch, target.sourceEpoch)
  );
}
