import type { WaitCursorEntry } from './contract.js';
import { waitJobHash, decodeWaitCursor, waitEpochPosition, upsertWaitCursorEntry } from './cursor.js';
import { z } from 'zod';

import { isRecord } from '../../infra/json.js';
import { continuitySnapshotSchema } from '../../sessions/continuity.js';
import { jobPhaseSchema } from '../phase.js';
import { jobProgressTimingSchema } from '../event-bodies.js';
import { jobTerminalSchema } from '../terminal/result.js';
import { usageSummarySchema } from '../../providers/contract.js';
import { type WaitCursor, type WaitHandoverNotice, type WaitStreamEvent } from './contract.js';

const KNOWN_WAIT_STREAM_EVENT_TYPES = new Set<string>([
  'progress',
  'queued',
  'terminal',
  'interrupted',
  'waiting',
  'notice',
  'disposition',
  'artifact',
]);
const waitCursorV3Schema = z.custom<Extract<WaitCursor, { version: 'jobs.wait.v3' }>>((value) => {
  const decoded = decodeWaitCursor(value);
  return decoded.kind === 'decoded' && decoded.cursor.version === 'jobs.wait.v3';
});
const waitCursorV2Schema = z.custom<Exclude<WaitCursor, { afterSeq: number }>>((value) => {
  const decoded = decodeWaitCursor(value);
  return decoded.kind === 'decoded' && decoded.cursor.version !== undefined;
});

export const MAX_WAIT_JOB_IDS = 128;

export type WaitRenderDecision = Readonly<{
  cursor: WaitCursor | undefined;
  shouldRender: boolean;
}>;

export function advanceWaitRenderCursor(cursor: WaitCursor | undefined, event: WaitStreamEvent): WaitRenderDecision {
  if ('version' in event && event.version === 'jobs.wait.v3') {
    if (event.type === 'progress') return { cursor: upsertWaitCursorEntry(cursor, event.entry), shouldRender: true };
    return { cursor: 'cursor' in event ? event.cursor : cursor, shouldRender: true };
  }
  cursor ??= { afterSeq: 0 };
  if (cursor.version === 'jobs.wait.v3') return { cursor, shouldRender: true };
  if (event.type === 'progress' || event.type === 'terminal') {
    if (event.epochKey !== undefined && event.cursor?.version === 'jobs.wait.v2') {
      const previous =
        cursor.version === 'jobs.wait.v2' ? (waitEpochPosition(cursor.positions, event.epochKey) ?? 0) : 0;
      if (
        event.type === 'terminal' &&
        cursor.version === 'jobs.wait.v2' &&
        cursor.deliveredJobIds?.includes(event.jobId)
      )
        return { cursor, shouldRender: false };
      if (event.type === 'progress' && event.seq <= previous) return { cursor, shouldRender: false };
      return {
        cursor: {
          version: 'jobs.wait.v2',
          locations: { ...event.cursor.locations },
          deliveredJobIds: [...new Set([...(cursor.deliveredJobIds ?? []), ...(event.cursor.deliveredJobIds ?? [])])],
          positions: Object.fromEntries(
            Object.entries(event.cursor.positions).map(([key, seq]) => [
              key,
              Math.max(seq, cursor.version === 'jobs.wait.v2' ? (waitEpochPosition(cursor.positions, key) ?? 0) : 0),
            ]),
          ),
        },
        shouldRender: true,
      };
    }

    const legacy = cursor.version === 'jobs.wait.v2' ? legacyRenderCursor(cursor.deliveredJobIds) : cursor;
    if (event.type === 'terminal') {
      if (legacy.deliveredJobIds?.includes(event.jobId))
        return { cursor: { ...legacy, afterSeq: Math.max(legacy.afterSeq, event.seq) }, shouldRender: false };
      return {
        cursor: {
          ...legacy,
          afterSeq: Math.max(legacy.afterSeq, event.seq),
          deliveredJobIds: [...(legacy.deliveredJobIds ?? []), event.jobId],
        },
        shouldRender: true,
      };
    }
    if (event.seq <= legacy.afterSeq) return { cursor: legacy, shouldRender: false };
    return { cursor: { ...legacy, afterSeq: event.seq }, shouldRender: true };
  }

  return { cursor: 'cursor' in event && event.cursor ? event.cursor : cursor, shouldRender: true };
}

function legacyRenderCursor(deliveredJobIds: readonly string[] | undefined): Extract<WaitCursor, { afterSeq: number }> {
  return deliveredJobIds === undefined || deliveredJobIds.length === 0
    ? { afterSeq: 0 }
    : { afterSeq: 0, deliveredJobIds: [...deliveredJobIds] };
}

const waitProgressEventSchema = z
  .object({
    type: z.literal('progress'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    message: z.string(),
    timing: jobProgressTimingSchema,
    version: z.literal('jobs.wait.v2').optional(),
    epochKey: z.string().min(1).optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

const waitQueuedEventBaseSchema = z.object({
  type: z.literal('queued'),
  jobId: z.string().min(1),
  queuePosition: z.number(),
  runningJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
  timing: jobProgressTimingSchema,
  cursor: waitCursorV2Schema.optional(),
});

const waitQueuedProviderEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('provider'),
    sessionId: z.string().min(1),
  })
  .passthrough();

const waitQueuedWorkflowEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('workflow'),
    workflowId: z.string().min(1),
  })
  .passthrough();

const waitQueuedKbEventSchema = waitQueuedEventBaseSchema
  .extend({
    jobKind: z.literal('kb'),
    systemTaskId: z.string().min(1),
  })
  .passthrough();

export const resultAvailabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), resultPath: z.string().min(1) }).strip(),
  z.object({ kind: z.literal('retained-away'), retentionDays: z.number().positive() }).strip(),
  z.object({ kind: z.literal('repair-pending'), ageUncertain: z.boolean() }).strip(),
  z
    .object({
      kind: z.literal('failed'),
      cause: z.enum([
        'repair-failed',
        'workflow-facts-unavailable',
        'source-epoch-retired',
        'terminal-age-unknown',
        'terminal-clock-regression',
        'cutoff-untrusted',
        'terminal-unusable',
      ]),
      retryScheduled: z.boolean(),
      ageUncertain: z.boolean().optional(),
      unverifiedResultPath: z.string().min(1).optional(),
    })
    .strip(),
]);

const waitTerminalEventSchema = z
  .object({
    type: z.literal('terminal'),
    jobId: z.string(),
    seq: z.number().int().nonnegative(),
    remainingJobIds: z.array(z.string()).max(MAX_WAIT_JOB_IDS),
    resultPath: z.string().min(1).optional(),
    availability: resultAvailabilitySchema.optional(),
    result: jobTerminalSchema,
    version: z.literal('jobs.wait.v2').optional(),
    continuity: continuitySnapshotSchema.nullable().optional(),
    usage: usageSummarySchema.optional(),
    epochKey: z.string().min(1).optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

/** Carrier interruption must reject terminal fields and cannot acknowledge an outcome. */
const waitCarrierInterruptedEventSchema = z
  .object({
    type: z.literal('interrupted'),
    version: z.never().optional(),
    jobId: z.string().min(1),
    storedPhase: jobPhaseSchema,
    observedMaxJournalSeq: z.number().int().nonnegative(),
    remainingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    observation: z.object({ kind: z.literal('carrier_interrupted'), reason: z.literal('carrier_absent') }).strip(),
    continuity: z.literal('unavailable'),
    outcome: z.literal('unknown'),
    cursor: waitCursorV2Schema.optional(),
  })
  .strip();

const waitWaitingEventSchema = z
  .object({
    type: z.literal('waiting'),
    version: z.never().optional(),
    waitingJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS),
    // Empty unknown coverage must omit the wire field.
    carrierUnknownJobIds: z.array(z.string().min(1)).max(MAX_WAIT_JOB_IDS).nonempty().optional(),
    cursor: waitCursorV2Schema.optional(),
  })
  .passthrough();

const entrySchema = z.custom<WaitCursorEntry>(
  (value) => decodeWaitCursor({ version: 'jobs.wait.v3', jobs: [value] }).kind === 'decoded',
);
const finalFields = {
  version: z.literal('jobs.wait.v3'),
  cursor: waitCursorV3Schema,
  exitCode: z.number().int().min(0).max(255),
};
const waitV3ProgressSchema = waitProgressEventSchema.extend({
  version: z.literal('jobs.wait.v3'),
  entry: entrySchema,
  cursor: z.never().optional(),
  exitCode: z.never().optional(),
  epochKey: z.never().optional(),
});
const waitV3TerminalSchema = waitTerminalEventSchema.extend({ ...finalFields, availability: resultAvailabilitySchema });
const waitV3WaitingSchema = waitWaitingEventSchema.extend(finalFields);
const waitV3InterruptedSchema = waitCarrierInterruptedEventSchema.extend({
  version: z.literal('jobs.wait.v3'),
  cursor: z.never().optional(),
  exitCode: z.never().optional(),
});
const waitNoticeSchema = z
  .object({
    type: z.literal('notice'),
    version: z.literal('jobs.wait.v3'),
    message: z.string(),
    cursor: z.never().optional(),
    exitCode: z.never().optional(),
  })
  .strip();
const waitDispositionSchema = z
  .object({
    type: z.literal('disposition'),
    version: z.literal('jobs.wait.v3'),
    jobId: z.string().min(1),
    disposition: z.enum([
      'missing',
      'discovery-unknown',
      'pre-epoch-history',
      'outcome-unrecoverable',
      'outcome-unreadable',
      'discovery-unreadable',
      'scope-mismatch',
    ]),
    message: z.string().optional(),
    cursor: z.never().optional(),
    exitCode: z.never().optional(),
  })
  .strip();
const waitArtifactSchema = z
  .object({
    ...finalFields,
    type: z.literal('artifact'),
    jobId: z.string().min(1),
    availability: resultAvailabilitySchema,
    remainingJobIds: z.array(z.string()).max(MAX_WAIT_JOB_IDS),
  })
  .strip();
const waitStreamEventSchema = z
  .union([
    waitV3ProgressSchema,
    waitV3TerminalSchema,
    waitV3WaitingSchema,
    waitV3InterruptedSchema,
    waitNoticeSchema,
    waitDispositionSchema,
    waitArtifactSchema,
    waitProgressEventSchema,
    waitQueuedProviderEventSchema,
    waitQueuedWorkflowEventSchema,
    waitQueuedKbEventSchema,
    waitTerminalEventSchema,
    waitCarrierInterruptedEventSchema,
    waitWaitingEventSchema,
  ])
  .superRefine((event, ctx) => {
    if (
      'cursor' in event &&
      event.cursor?.version === 'jobs.wait.v3' &&
      (!('version' in event) || event.version !== 'jobs.wait.v3')
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'V3 cursor requires a V3 event' });
    if (event.type === 'progress' && event.version === 'jobs.wait.v3' && event.entry.hash !== waitJobHash(event.jobId))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Progress entry belongs to another job' });
    if (
      event.type === 'terminal' &&
      (event.version === 'jobs.wait.v3'
        ? !event.availability ||
          (event.availability.kind === 'available'
            ? event.resultPath !== event.availability.resultPath
            : event.resultPath !== undefined)
        : !event.resultPath || event.availability !== undefined)
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

/** Unknown event types must not terminate the subscription. */
export function parseWaitStreamEventValue(value: unknown): WaitStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !KNOWN_WAIT_STREAM_EVENT_TYPES.has(value.type)) {
    return null;
  }
  if (
    value.type === 'interrupted' &&
    ['result', 'resultPath', 'availability', 'exitCode', 'usage'].some((key) => key in value)
  )
    throw new Error('Carrier interruption cannot deliver a terminal outcome');
  return waitStreamEventSchema.parse(value) as WaitStreamEvent;
}

export function isWaitHandoverNotice(value: unknown): value is WaitHandoverNotice {
  return isRecord(value) && value.type === 'handover';
}
