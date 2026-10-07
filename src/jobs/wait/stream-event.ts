import { decodeWaitCursor } from './cursor.js';
import { z } from 'zod';

import { isRecord } from '../../infra/json.js';
import { continuitySnapshotSchema } from '../../sessions/continuity.js';
import { jobPhaseSchema } from '../phase.js';
import { jobProgressTimingSchema } from '../event-bodies.js';
import { jobTerminalSchema } from '../terminal/result.js';
import { usageSummarySchema } from '../../providers/contract.js';
import { isFinalWaitEvent, type WaitCursor, type WaitHandoverNotice, type WaitStreamEvent } from './contract.js';

const KNOWN_WAIT_STREAM_EVENT_TYPES = new Set<string>([
  'progress',
  'queued',
  'terminal',
  'interrupted',
  'waiting',
  'notice',
  'disposition',
  'cursor',
]);
const waitCursorSchema = z.custom<WaitCursor>((value) => decodeWaitCursor(value).kind === 'decoded');

export const MAX_WAIT_JOB_IDS = 128;

export type WaitRenderDecision = Readonly<{
  cursor: WaitCursor | undefined;
  shouldRender: boolean;
}>;

/** The client's cursor is the last one a frame or final event named; a cursor frame is never rendered. */
export function advanceWaitRenderCursor(cursor: WaitCursor | undefined, event: WaitStreamEvent): WaitRenderDecision {
  if (event.type === 'cursor') return { cursor: event.cursor, shouldRender: false };
  return { cursor: isFinalWaitEvent(event) ? (event.cursor ?? undefined) : cursor, shouldRender: true };
}

const finalFields = {
  cursor: waitCursorSchema.nullable(),
  exitCode: z.number().int().min(0).max(255),
};
const nonFinalFields = {
  cursor: z.never().optional(),
  exitCode: z.never().optional(),
};

const waitProgressEventSchema = z
  .object({
    type: z.literal('progress'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    message: z.string(),
    timing: jobProgressTimingSchema,
    ...nonFinalFields,
  })
  .strip();

const waitQueuedEventBaseSchema = z.object({
  type: z.literal('queued'),
  jobId: z.string().min(1),
  queuePosition: z.number(),
  runningJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
  timing: jobProgressTimingSchema,
  ...nonFinalFields,
});

const waitQueuedEventSchema = z.discriminatedUnion('jobKind', [
  waitQueuedEventBaseSchema.extend({ jobKind: z.literal('provider'), sessionId: z.string().min(1) }).strip(),
  waitQueuedEventBaseSchema.extend({ jobKind: z.literal('workflow'), workflowId: z.string().min(1) }).strip(),
  waitQueuedEventBaseSchema.extend({ jobKind: z.literal('kb'), systemTaskId: z.string().min(1) }).strip(),
]);

export const resultAvailabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), resultPath: z.string().min(1) }).strip(),
  z.object({ kind: z.literal('retained-away'), retentionDays: z.number().positive() }).strip(),
  z.object({ kind: z.literal('pending') }).strip(),
  z.object({ kind: z.literal('failed'), reason: z.string().min(1) }).strip(),
]);

const waitTerminalBlockSchema = z.object({
  type: z.literal('terminal'),
  jobId: z.string(),
  seq: z.number().int().nonnegative(),
  remainingJobIds: z.array(z.string()).max(MAX_WAIT_JOB_IDS),
  resultPath: z.string().min(1).optional(),
  availability: resultAvailabilitySchema,
  result: jobTerminalSchema,
  continuity: continuitySnapshotSchema.nullable().optional(),
  usage: usageSummarySchema.optional(),
  epochKey: z.string().min(1).optional(),
});

/** Carrier interruption must reject terminal fields and cannot acknowledge an outcome. */
const waitCarrierInterruptedEventSchema = z
  .object({
    type: z.literal('interrupted'),
    jobId: z.string().min(1),
    storedPhase: jobPhaseSchema,
    observedMaxJournalSeq: z.number().int().nonnegative(),
    remainingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    observation: z.object({ kind: z.literal('carrier_interrupted'), reason: z.literal('carrier_absent') }).strip(),
    continuity: z.literal('unavailable'),
    outcome: z.literal('unknown'),
    result: z.never().optional(),
    resultPath: z.never().optional(),
    availability: z.never().optional(),
    usage: z.never().optional(),
    ...nonFinalFields,
  })
  .strip();

const waitWaitingEventSchema = z
  .object({
    type: z.literal('waiting'),
    waitingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    // Empty unknown coverage must omit the wire field.
    carrierUnknownJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS).nonempty().optional(),
    ...finalFields,
  })
  .strip();

const waitNoticeSchema = z
  .object({
    type: z.literal('notice'),
    message: z.string(),
    ...nonFinalFields,
  })
  .strip();
const waitCursorFrameSchema = z
  .object({
    type: z.literal('cursor'),
    cursor: waitCursorSchema,
    exitCode: z.never().optional(),
  })
  .strip();
const waitDispositionSchema = z
  .object({
    type: z.literal('disposition'),
    jobId: z.string().min(1),
    disposition: z.enum(['missing', 'scope-mismatch', 'unknown', 'unreadable']),
    message: z.string().optional(),
    ...nonFinalFields,
  })
  .strip();
const waitStreamEventSchema = z
  .union([
    waitProgressEventSchema,
    waitTerminalBlockSchema.extend(finalFields).strip(),
    waitTerminalBlockSchema.extend(nonFinalFields).strip(),
    waitWaitingEventSchema,
    waitCarrierInterruptedEventSchema,
    waitNoticeSchema,
    waitCursorFrameSchema,
    waitDispositionSchema,
    waitQueuedEventSchema,
  ])
  .superRefine((event, ctx) => {
    if (
      event.type === 'terminal' &&
      (event.availability.kind === 'available'
        ? event.resultPath !== event.availability.resultPath
        : event.resultPath !== undefined)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal artifact contract mismatch' });
  });

export function parseWaitStreamEvent(eventType: string | undefined, rawData: string): WaitStreamEvent | null {
  if (!eventType || !KNOWN_WAIT_STREAM_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const parsed: unknown = JSON.parse(rawData);
  const event = parseWaitStreamEventValue(parsed);
  if (event === null || event.type !== eventType) {
    throw new Error(`Invalid wait stream event payload for ${eventType}`);
  }
  return event;
}

/** Unknown event types must not terminate the subscription; a known type in another shape is another build's. */
export function parseWaitStreamEventValue(value: unknown): WaitStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !KNOWN_WAIT_STREAM_EVENT_TYPES.has(value.type)) {
    return null;
  }
  return waitStreamEventSchema.parse(value) as WaitStreamEvent;
}

export function isWaitHandoverNotice(value: unknown): value is WaitHandoverNotice {
  return isRecord(value) && value.type === 'handover';
}
